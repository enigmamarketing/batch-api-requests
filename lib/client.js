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

var url = require('url'),
    http = require('http'),
    Q = require('q'),
    merge = require('merge'),
    Obj;

Obj = function (opts) {
    var self = this;

    if (!opts.url) {
        throw new Error('A batch client requires an URL');
    }

    self.opts = opts;
    self.opts.url = url.parse(self.opts.url);

    self.pendingRequests = {};
    self.buffer = [];
};

// options
Obj.prototype.opts = null;
// used as Content-ID
Obj.prototype.sentItems = 0;
// holds Callbacks for requests
Obj.prototype.pendingRequests = null;
// holds the req object of the connection
Obj.prototype.connection = null;
// A connection becomes invalid when the close method is called
// we will only close the connection when all CBs are called
Obj.prototype.isConnectionValid = true;
// string used as boundary in multipart body
Obj.prototype.boundary = null;
// array of lines returned by server
Obj.prototype.buffer = null;
// The first block in the response. The preamble string
// may be empty, but we still require one being present
Obj.prototype.preamble = null;

Obj.prototype.killConnection = function (e) {
    var self = this;
    // return the err to all pending callbacks so they can be 
    // retried by the user client code
    Object.keys(self.pendingRequests).forEach(function (index) {
        var cb = self.pendingRequests[index];
        setImmediate(cb, e || new Error('connection closed'));
    });
    // destroy the current connection so our send method 
    // creates a new one
    self.connection = null;
};

Obj.prototype.connect = function () {
    var self = this,
        req;

    if (self.connection) {
        return self.connection;
    }

    // create a new boundary string
    // keep length < 70 chars
    self.boundary = '===============';
    self.boundary += (+new Date());
    self.boundary += '_';
    self.boundary += Math.round(Math.random() * 1000000);
    self.boundary += '==';

    req = http.request({
        method: 'POST',
        protocol: self.opts.url.protocol,
        hostname: self.opts.url.hostname,
        port: self.opts.url.port,
        path: self.opts.url.path,
        headers: merge(self.opts.headers, {
            'Transfer-Encoding': 'chunked',
            'Content-Type': 'multipart/mixed; boundary="' + self.boundary + '"'
        })
        //todo: support basic auth?
    }, function (res) {
        res.setEncoding('utf8');
        res.on('data', self.parseIncoming.bind(self));

        res.on('end', self.killConnection.bind(self));
    });

    req.on('error', self.killConnection.bind(self));

    // ##################
    // hack:
    // Not sure why but these initial req.writes are being sent with \r\n
    // but the ones in the send method are not!!
    // ##################

    // Preamble
    req.write('Batch API.');
    req.write('More information on the module GitHub repo:');
    req.write('https://github.com/enigmamarketing/batch-api-requests');

    self.connection = req;
    return req;
};

Obj.prototype.parseIncoming = function (data) {
    var self = this,
        lines = data.split('\r\n');

    self.buffer = self.buffer.concat(lines);

    if (!self.preamble) {
        // we're initialising the buffer. The first
        // lines will be either empty or contain a preamble
        self.extractPreamble();

        // The preamble hasn't finished loading
        // we don't want the parseBuffer method to 
        // try and parse this data;
        if (!self.preamble) {
            return;
        }
    }

    self.parseBuffer();
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

Obj.prototype.parseBuffer = function () {
    var self = this,
        buffer = self.buffer,
        boundary = self.boundary,
        obj = {},
        blocks = ['headers', 'response', 'body'],
        currentBlockIndex = 0,
        index = 0,
        stop = false,
        line = '';

    function saveProperty() {
        var data;

        if (currentBlockIndex === 0) {
            //it's a header -> key: value
            data = line.match(/^([a-zA-Z-]+): ?(.+)/);

            if (obj[blocks[currentBlockIndex]] === undefined) {
                obj[blocks[currentBlockIndex]] = {};
            }
            if (data) {
                obj[blocks[currentBlockIndex]][data[1].toLowerCase()] = data[2];
            } else {
                console.log(new Error('malformed buffer line: ' + line));
            }

        } else if (currentBlockIndex === 1) {
            if (obj[blocks[currentBlockIndex]] === undefined) {
                // request -> HTTP/1.1 statusCode statusMessage
                obj[blocks[currentBlockIndex]] = {
                    headers: {}
                };
                data = line.match(/^HTTP\/1\.1 ([0-9]{1,3}) (.+)$/);
                if (data) {
                    obj[blocks[currentBlockIndex]].statusCode = data[1];
                    obj[blocks[currentBlockIndex]].statusMessage = data[2];
                } else {
                    console.log(new Error('malformed buffer line: ' + line));
                }
            } else {
                // headers
                data = line.match(/^([a-zA-Z-]+): ?(.+)/);
                if (data) {
                    obj[blocks[currentBlockIndex]].headers[data[1].toLowerCase()] = data[2];
                } else {
                    console.log(new Error('malformed buffer line: ' + line));
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

    while (index < buffer.length) {
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

            self.callPendingRequest(obj);

            // reset tmp vars
            index = 0;
            obj = {};
            currentBlockIndex = 0;

            if (line === '--' + boundary + '--') {
                self.close();
            }

            continue;
        } else {
            saveProperty()
        }

        index += 1;
    }
};

Obj.prototype.callPendingRequest = function (obj) {
    var self = this,
        contentId = obj.headers['content-id'],
        cb = self.pendingRequests[contentId];

    if (!cb) {
        return;
    }

    cb(null, obj.body, obj.response);
};

Obj.prototype.send = function (item, cb) {
    var self = this,
        conn,
        response = '',
        contentId;

    if (!item.method || !item.path) {
        throw new Error('Invalid item. Method and Path are required properties.');
    }

    if (!self.isConnectionValid) {
        if (cb) {
            setImmediate(cb, new Error('Connection was closed before calling send.'));
        }
        return self;
    }

    self.sentItems += 1;
    contentId = self.sentItems;

    conn = self.connect();

    response += '\r\n--' + self.boundary;
    response += '\r\nContent-Type: application/http';
    response += '\r\nContent-Transfer-Encoding: binary';
    response += '\r\nContent-ID: ' + contentId;
    response += '\r\n';
    response += '\r\n' + item.method.toUpperCase() + ' ' + item.path + ' HTTP/1.1';
    response += '\r\nAccept: application/json';

    if (item.body) {
        response += '\r\nTransfer-Encoding: chunked';
        response += '\r\nContent-Type: application/json';

        if (typeof item.body !== 'string') {
            item.body = JSON.stringify(item.body);
        }
        response += '\r\n\r\n' + item.body;
    }

    conn.write(response);
    // No need to handle response if no Callback was provided.
    // If all we want is fire and forget POST/PUT we may skip this argument
    // but we will have no feedback on failed requests
    if (cb) {
        // when the CB is called we remove it from the 
        // pending requests object
        self.pendingRequests[contentId] = function (err, body, response) {
            cb(err, body, response);
            delete self.pendingRequests[contentId];

            if (self.isConnectionValid === false) {
                self.close();
            }
        };
    }

    return self;
};

// Stop accepting any more sends.
Obj.prototype.close = function () {
    var self = this,
        conn = self.connection;

    // we may call close multiple times.
    if (self.isConnectionValid) {
        if (conn && conn.write) {
            conn.write('\r\n--' + self.boundary + '--\r\n');
            conn.end();
            self.connection = null;
        }

        self.isConnectionValid = false;
    }

    return self;
};

module.exports = {
    connect: function (opts) {
        return new Obj(opts)
    }
};