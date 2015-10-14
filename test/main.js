/*jslint node:true, unparam: true, nomen: true */
/*global describe, it, afterEach*/
'use strict';

var assert = require("assert"),
    batchServer = require('../lib').server,
    batchClient = require('../lib').client,
    express = require('express'),
    httpHost = 'localhost',
    httpPort = 8080,
    httpPath = '/batch',
    items = [],
    server;

function dummyResponse(req, res) {
    var rTime = Math.round(Math.random() * 10);

    setTimeout(function () {
        res.json({
            status: 'ok',
            headers: req.headers
        });
    }, rTime);
}

describe('Batch Processing', function () {
    before(function (done) {
        server = express()
            .use(httpPath, batchServer({
                protocol: 'http',
                logger: false
            }))
            .use(dummyResponse)
            .listen(httpPort, function (err) {
                done(err);
            });
    });

    after(function () {
        server.close();
    });

    it('Should connect and send one item', function (done) {
        batchClient
            .connect({
                url: 'http://' + httpHost + ':' + httpPort + httpPath
            })
            .send({
                method: 'POST',
                path: '/test',
                body: '{"id":"OK", "test": 123}'
            }, function (error, body, response) {
                done();
            })
            .close();
    });

    it('Should use header authorization', function (done) {
        var myToken = '3LpNcVj3qJ2PcQZK3LGTd7zz27JAUmV';

        batchClient
            .connect({
                url: 'http://' + httpHost + ':' + httpPort + httpPath,
                headers: {
                    Authorization: 'Bearer ' + myToken
                }
            })
            .send({
                method: 'POST',
                path: '/test',
                body: '{"id":"OK", "test": 123}'
            }, function (error, body, response) {
                var data = JSON.parse(body);

                assert.equal('Bearer ' + myToken, data.headers.authorization);
                done();
            })
            .close();
    });

    it('Should connect and send multiple items', function (done) {
        var i = 0,
            r = 0,
            numRequests = 12,
            batchConnection = batchClient.connect({
                url: 'http://' + httpHost + ':' + httpPort + httpPath
            });

        for (i = 0; i < numRequests; i += 1) {
            batchConnection.send({
                method: 'POST',
                path: '/test/' + i,
                body: '{"id":"OK", "test": 123}'
            }, function (error, body, response) {
                r += 1;

                if (r === numRequests) {
                    done();
                }
            });
        }

        batchConnection.close();
    });

    it('Should return error after connection close', function (done) {
        batchClient
            .connect({
                url: 'http://' + httpHost + ':' + httpPort + httpPath
            })
            .send({
                method: 'POST',
                path: '/test',
                body: '{"id":"OK", "test": 123}'
            })
            .close()
            .send({
                method: 'POST',
                path: '/test',
                body: '{"id":"OK", "test": 123}'
            }, function (error, body, response) {
                assert.notEqual(error, null);
                done();
            })
    });
});