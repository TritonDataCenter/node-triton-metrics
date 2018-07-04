/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Example server. Run with:
 *
 *   node example-fooserver.js
 *
 * Then you can make requests to GET http://127.0.0.1:8888/foo and should get
 * back a response 'foo'.
 *
 * You can also look at the metrics with GET http://127.0.0.1:8889/metrics to
 * see what these look like for your `GET /foo` requests.
 *
 */

var os = require('os');

var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');

var log = new bunyan({
    name: 'foo',
    level: 'info',
    serializers: {
        err: bunyan.stdSerializers.err,
        req: bunyan.stdSerializers.req,
        res: bunyan.stdSerializers.res
    }
});

var metricsManager = createMetricsManager({
    address: '127.0.0.1',
    log: log.child({component: 'metrics'}),
    port: 8889,
    restify: restify,
    staticLabels: {
        datacenter: 'dummy',
        instance: 'foo0',
        server: os.hostname(),
        service: 'foo'
    }
});

metricsManager.createRestifyMetrics();
metricsManager.createGCMetrics();
metricsManager.createNodeMetrics();

metricsManager.listen(function metricsServerStarted() {
    var server = restify.createServer({
        handleUncaughtExceptions: false,
        name: 'Foo API',
        log: log
    });

    server.use(restify.requestLogger());

    server.get('/foo', function _onFoo(req, res, next) {
        res.send(204); // No Content
        next();
    });

    server.on('after', function _doLogging(req, res, route, err) {
        metricsManager.collectRestifyMetrics(req, res, route);
        restify.auditLogger({log: log})(req, res, route, err);
    });

    server.listen(8888, '127.0.0.1', function _onListen() {
        log.info('%s listening at %s', server.name, server.url);
    });
});
