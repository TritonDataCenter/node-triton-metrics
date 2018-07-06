/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * The EventloopMetrics object keeps track of 2 metrics:
 *
 *  eventloop lag
 *
 *    To measure this, it sets a timer with setTimeout(fn, delay) and then
 *    measures the delta between the setTimeout call and the execution time of
 *    fn() minus the delay to give the eventloop lag value.
 *
 *  eventloop time
 *
 *    To measure this, it calls setImmediate(fn) and measures the total amount
 *    of time between the setImmediate call and the execution of fn().
 *
 * The units for both of these values is seconds.
 *
 * Quickstart:
 *
 *   var eventloopMetrics = new EventloopMetrics({[pollFrequencyMs: 500]});
 *   eventloopMetrics.start();
 *   eventloopMetrics.getLag();  // returns latest eventloop lag in seconds
 *   eventloopMetrics.getTime(); // returns latest eventloop time in seconds
 *
 * You could also pass in a handler like:
 *
 *   var eventloopMetrics = new EventloopMetrics({[pollFrequencyMs: 500]});
 *   eventloopMetrics.start(function _onMetrics(metrics) {
 *       console.log("lag: %d, time: %d", metrics.lag, metrics.time);
 *   });
 *
 * The only option currently supported by eventloopMetrics is 'pollFrequencyMs'
 * which is a number of milliseconds to delay with setTimeout between metrics
 * samplings. The default value is 500.
 *
 * Notes:
 *
 *   * It is possible to set a handler with:
 *
 *       eventloopMetrics.setHandler(handlerFn);
 *
 *   * In order to stop the looping of the handler, it is possible to call:
 *
 *       eventloopMetrics.stop();
 *
 */

var assert = require('assert-plus');

var DEFAULT_EVENTLOOP_POLL_MS = 500;
var NS_PER_SECOND = 1e9;

// Convert a process.hrtime() diff Array into a (returned) number of seconds.
function deltaToSecs(delta) {
    return delta[0] + delta[1] / NS_PER_SECOND;
}

function EventloopMetrics(opts) {
    var self = this;

    if (opts === undefined) {
        opts = {};
    }

    assert.object(opts, 'opts');
    assert.optionalNumber(opts.pollFrequencyMs, 'opts.pollFrequencyMs');

    self.pollFrequencyMs = opts.pollFrequencyMs || DEFAULT_EVENTLOOP_POLL_MS;

    self.lastLag = 0;
    self.lastTime = 0;

    // Set true when we're .stop()ing so we don't start another timer.
    self.stopAsap = false;
}

EventloopMetrics.prototype.updateEventloopData = function updateEventloopData() {
    var self = this;
    var start = process.hrtime();

    if (self.stopAsap) {
        // Don't start another timer if we're trying to stop.
        return;
    }

    self.timer = setTimeout(function _measureEventloopLag() {
        var lag;
        var timeoutDeltaSecs = deltaToSecs(process.hrtime(start));

        // Note: due to the issue described in:
        //
        // https://github.com/nodejs/node/issues/10154
        //
        // the lag here might end up being up to 1ms ahead of where it should
        // be. (i.e. lag = -0.001)
        lag = timeoutDeltaSecs - self.pollFrequencyMs / 1000;

        // Now that we've measured the lag, we want to gather the eventloop time
        // and also queue the next measurement. We'll combine the two in a
        // single setImmediate call.
        start = process.hrtime();
        setImmediate(function _measureEventloopTime() {
            var time = deltaToSecs(process.hrtime(start));

            // This will do a new setTimeout and start the loop again. We don't
            // use a setInterval() because of the potential case where the lag
            // is large and greater than or close to the interval.
            self.updateEventloopData();

            self.lastLag = lag;
            self.lastTime = time;

            // If a handlerFn is set, we'll call it and pass in the data. This
            // could be used to implement something like:
            //
            //   https://github.com/lloyd/node-toobusy
            //
            if (self.handlerFn !== undefined) {
                self.handlerFn({
                    lag: lag,
                    time: time
                });
            }
        });
    }, self.pollFrequencyMs);
};

EventloopMetrics.prototype.getLag = function getLag() {
    var self = this;

    return self.lastLag;
};

EventloopMetrics.prototype.getTime = function getTime() {
    var self = this;

    return self.lastTime;
};

//
// This allows the handlerFn to be set after .start(). Note that there is only
// one handlerFn, so any existing handler will be replaced. It can also be set
// to undefined to remove an existing handler.
//
EventloopMetrics.prototype.setHandler = function setHandler(handlerFn) {
    var self = this;

    assert.optionalFunc(handlerFn, 'handlerFn');

    self.handlerFn = handlerFn;
};

EventloopMetrics.prototype.start = function start(handlerFn) {
    var self = this;

    self.setHandler(handlerFn);

    // Kick off the first poll (which will kick off subsequent polls itself)
    self.updateEventloopData();
};

EventloopMetrics.prototype.stop = function stop() {
    var self = this;

    self.stopAsap = true;
    clearTimeout(self.timeout);
};

module.exports = EventloopMetrics;

//
// When run directly, this will just output the metrics every second.
// (Serves as a usage example)
//
if (require.main === module) {
    var em = new EventloopMetrics({
        pollFrequencyMs: 1000
    });

    em.start(function(metrics) {
        console.log(JSON.stringify(metrics));
    });
}
