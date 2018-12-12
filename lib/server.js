/*jslint node:true, nomen:true */
'use strict';
/*
    Copyright 2015 Enigma Marketing Services Limited

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

// https://cloud.google.com/storage/docs/json_api/v1/how-tos/batch?hl=en
// http://www.w3.org/Protocols/rfc1341/7_2_Multipart.html

var http = require('http'),
    errors = require('common-errors'),
    request = require('request'),
    merge = require('merge'),
    fallbackLogger,
    Obj;

Obj = function (opts, connection) {
    var self = this;

    self.opts = {};

    self.opts.parallelLimit = (opts && opts.parallelLimit) || 10;
    self.opts.protocol = (opts && opts.protocol) || 'https';
    self.opts.timeout = (opts && opts.timeout) || 5000;
    self.opts.retries = (opts && opts.parallelLimit) || 0;

    if (opts && opts.logger === false) {
        self.logger = {
            error: function () {},
            warn: function () {},
            info: function () {}
        };
    } else {
        self.logger = (opts && opts.logger) || {
            error: console.error,
            warn: console.log,
            info: console.log
        };
    }

    self.connection = connection;

    self.buffer = [];
    self.isBufferPaused = false;
    self.hasClientFinished = false;
    self.numPendingRequests = 0;
}

Obj.prototype.opts = null;
Obj.prototype.boundary = null;
Obj.prototype.logger = null;
Obj.prototype.preamble = null;
Obj.prototype.buffer = null;
Obj.prototype.numPendingRequests = null;
Obj.prototype.isBufferPaused = null;
Obj.prototype.hasClientFinished = null;

Obj.prototype.doRequest = function (obj, numTries) {
    var self = this,
        req = self.connection.req,
        contentId = obj.headers['content-id'],
        options = {};

    self.numPendingRequests += 1;

    self.logger.info('Processing. Boundary:' + self.boundary + ' ID:' + obj.headers['content-id']);

    options = {
        method: obj.request.method,
        url: self.opts.protocol + '://' + req.headers.host + obj.request.path,
        headers: merge(req.headers, obj.request.headers),
        timeout: self.opts.timeout,
        json: true
    };

    if (obj.body && obj.body.length > 0) {
        options.body = JSON.parse(obj.body);
    }

    request(options, function (error, response, body) {
        var n = numTries || 1,
            t = (Math.random() * 5000) + n * 1000;

        if (error || response.statusCode < 200 || response.statusCode > 300) {
            if (self.opts.retries && self.opts.retries < n) {
                self.logger.warn('Boundary:' + self.boundary + ' ID:' + obj.headers['content-id'] + response.statusCode + ' ' + error);

                setTimeout(function () {
                    self.doRequest(obj, n + 1);
                }, t);
                return;
            } else {
                self.logger.error('Boundary:' + self.boundary + ' ID:' + obj.headers['content-id'] + (response && response.statusCode || '') + ' ' + error);
            }
        }

        self.numPendingRequests -= 1;
        self.reply(contentId, error, response, body);
        self.parseBuffer();
    });
};

Obj.prototype.reply = function (contentId, error, response, body) {
    var self = this,
        res = self.connection.res,
        message = '',
        statusCode = (response && response.statusCode) || 0,
        statusMessage = (statusCode && http.STATUS_CODES[statusCode]) || 'Error';

    message += '\r\n--' + self.boundary;
    message += '\r\nContent-Type: application/http';
    message += '\r\nContent-ID: ' + contentId;
    message += '\r\n';
    message += '\r\nHTTP/1.1 ' + statusCode + ' ' + statusMessage;

    if (response && response.headers) {
        Object.keys(response.headers).forEach(function (key) {
            message += '\r\n' + key + ': ' + response.headers[key];
        });
    }

    message += '\r\n';

    if (body) {
        message += '\r\n';
        message += (typeof body === 'string' ? body : JSON.stringify(body));
    } else {
        message += '\r\n';
        message += error;
    }

    res.write(message);

    if (self.numPendingRequests <= 0 && self.hasClientFinished) {
        res.write('\r\n--' + self.boundary + '--');
        res.end();
    }
};

Obj.prototype.setBoundary = function (contentType) {
    var self = this,
        boundary;

    boundary = contentType.replace('multipart/mixed; boundary=', '');
    boundary = boundary.replace(/"|'/g, '');

    self.boundary = boundary;
};

Obj.prototype.extractPreamble = function () {
    var self = this,
        buffer = self.buffer,
        index = buffer.indexOf('--' + self.boundary),
        preamble;

    if (self.preamble || index === -1) {
        return;
    }

    preamble = buffer.splice(0, index + 1);
    preamble.pop(); //remove the boundary line

    self.preamble = preamble.join('\r\n');

    return self.preamble;
};

Obj.prototype.parseIncoming = function (data) {
    var self = this,
        req = self.connection.req,
        lines = data.split('\r\n'),
        numRequests;


    if (self.hasClientFinished) {
        return;
    }

    self.buffer = self.buffer.concat(lines);

    if (!self.preamble) {
        // we're initialising the buffer. The first
        // lines will be either empty or contain a preamble
        self.extractPreamble();
    }

    numRequests = self.getBufferPendingRequests();

    if (!self.isBufferPaused && numRequests > self.opts.parallelLimit) {
        self.logger.info('pausing ' + self.boundary);
        self.isBufferPaused = true;
        req.pause();
    }

    if (numRequests >= 1 && self.numPendingRequests < self.opts.parallelLimit) {
        self.parseBuffer();
    }
};

Obj.prototype.getBufferPendingRequests = function () {
    var self = this,
        numRequests = self.buffer.reduce(function (previous, current) {
            if (current.indexOf('--' + self.boundary) === 0) {
                previous += 1;
            }
            return previous;
        }, 0);

    return numRequests;
};

Obj.prototype.parseBuffer = function () {
    var self = this,
        buffer = self.buffer,
        parallelLimit = self.opts.parallelLimit,
        boundary = self.boundary,
        obj = {},
        blocks = ['headers', 'request', 'body'],
        numRequests,
        currentBlockIndex = 0,
        index = 0,
        stop = false,
        line = '';

    if (self.hasClientFinished) {
        return;
    }

    function saveProperty() {
        var data;

        if (currentBlockIndex === 0) {
            //it's a header -> key: value
            data = line.match(/^([a-zA-Z-]+): ?(.+)/);

            if (obj[blocks[currentBlockIndex]] === undefined) {
                obj[blocks[currentBlockIndex]] = {};
            }

            obj[blocks[currentBlockIndex]][data[1].toLowerCase()] = data[2];
        } else if (currentBlockIndex === 1) {
            if (obj[blocks[currentBlockIndex]] === undefined) {
                // request -> METHOD path HTTP/1.1
                obj[blocks[currentBlockIndex]] = {
                    headers: {}
                };
                data = line.match(/^([A-Z]+) (.+) HTTP\/1\.1$/);
                if (data) {
                    obj[blocks[currentBlockIndex]].method = data[1];
                    obj[blocks[currentBlockIndex]].path = data[2];
                } else {
                    self.logger.error(new Error('malformed buffer line: ' + line));
                }
            } else {
                // headers
                data = line.match(/^([a-zA-Z-]+): ?(.+)/);
                if (data) {
                    obj[blocks[currentBlockIndex]].headers[data[1].toLowerCase()] = data[2];
                } else {
                    self.logger.error(new Error('malformed buffer line: ' + line));
                }
            }
        } else {
            //body
            if (obj[blocks[currentBlockIndex]] === undefined) {
                obj[blocks[currentBlockIndex]] = line;
            } else {
                obj[blocks[currentBlockIndex]] += line;
            }
        }
    }

    while (index < buffer.length && self.numPendingRequests < parallelLimit) {
        line = buffer[index];

        if (line === '') {
            if (obj[blocks[currentBlockIndex]]) {
                // if the current section already exists 
                // a blank line represents a move to the next 
                // section
                // 
                // CRLFs in the body section will be ignored
                if (currentBlockIndex < 2) {
                    currentBlockIndex += 1;
                }
            } else {
                // a blank space instead of a section means
                // we must leave that section empty and the 
                // default values (if any) will be used
                obj[blocks[currentBlockIndex]] = {};
            }
        } else if (line.indexOf('--' + boundary) === 0) {
            // delete the processed lines so far
            buffer.splice(0, index + 1);

            self.doRequest(obj);

            // reset tmp vars
            index = 0;
            obj = {};
            currentBlockIndex = 0;

            if (line === '--' + boundary + '--') {
                self.hasClientFinished = true;
            }

            continue;
        } else {
            saveProperty()
        }

        index += 1;
    }

    numRequests = self.getBufferPendingRequests();

    if (self.isBufferPaused && numRequests < self.opts.parallelLimit) {
        self.logger.info('resuming ' + self.boundary);
        self.isBufferPaused = false;
        self.connection.req.resume();
    }
};

Obj.prototype.handleReq = function () {
    var self = this,
        req = self.connection.req,
        res = self.connection.res,
        contentType = req.headers['content-type'];

    if (req.method !== 'POST') {
        return next();
    }

    if (contentType.indexOf('multipart/mixed; boundary=') !== 0) {
        return next(new errors.HttpStatusError(415, 'Unsupported Media Type]'));
    }

    self.setBoundary(contentType);

    req.setEncoding('utf8');
    req.on('data', self.parseIncoming.bind(self));

    req.on('end', function () {
        self.logger.warn('Connection ' + self.boundary + ' ended with Buffer:' + self.buffer.length + ' Pending Req:' + self.numPendingRequests);
    });

    res.status(200)
    res.set('Content-Type', 'multipart/mixed; boundary="' + self.boundary + '"');

    res.write('Batch API.');
    res.write('More information on the module GitHub repo:');
    res.write('https://github.com/enigmamarketing/batch-api-requests');
};


module.exports = function (options) {
    return function (req, res, next) {
        var obj = new Obj(options, {
            req: req,
            res: res,
            next: next
        });

        obj.handleReq();
    };
};