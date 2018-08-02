/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * The EventloopMetrics object keeps track of 2 fundamental metrics about the
 * eventloop:
 *
 *
 *  eventloop lag
 *
 *    To measure this, it sets a timer with setTimeout(fn, delay) and then
 *    measures the delta between the setTimeout call and the execution time of
 *    fn() minus the delay to give the eventloop lag value.
 *
 *    Values tracked here are:
 *
 *      lagMax   -- maximum lag sampled (nanoseconds) since last .get()
 *      lagMin   -- minimum lag sampled (nanoseconds) since last .get()
 *      lagSum   -- sum of all lag samples (nanoseconds) since last .get()
 *
 *    The lagSum and sampleCount can be divided to determine the average lag for
 *    the period.
 *
 *
 *  eventloop time
 *
 *    The libuv event loop has a 'Run check handles' phase:
 *
 *    http://docs.libuv.org/en/v1.x/design.html#the-i-o-loop
 *
 *    to which the 'event-loop-stats' module here ties 'uv_check_*' functions.
 *    This way, it is able to increment its internal variables on every tick of
 *    the eventloop.
 *
 *    Values we expose here are:
 *
 *      loopCountMax  -- maximum number of loops seen in any single sample since
 *                       last .get()
 *      loopCountMin  -- minimum number of loops seen in any single sample since
 *                       last .get()
 *      loopCountSum  -- total number of eventloop ticks since last .get()
 *
 *      loopTimeMax   -- maximum time (nanoseconds) spent between start of loop
 *                       and check handle being run.
 *      loopTimeMin   -- minimum time (nanoseconds) spent between start of loop
 *                       and check handle being run.
 *      loopTimeSum   -- sum (nanoseconds) of all time samples between start of
 *                       loop and check handle being run.
 *
 * There is also one additional value exposed:
 *
 *   sampleCount  -- indicates how many samples (setTimeout loops) were
 *                   collected since the last call to .get().
 *
 * Usage:
 *
 *   There are 2 modes in which this module can operate (both can be used
 *   simultaneously).
 *
 *
 *   The first (and expected to be primary) mechanism is to run:
 *
 *     var data = {};
 *     var eventloopMetrics = new EventloopMetrics({[pollFrequencyMs: 500]});
 *
 *     eventloopMetrics.start();
 *     // <do something>
 *     data = eventloopMetrics.get();
 *
 *   In this mode, each time eventloopMetrics.get() is called, metrics will be
 *   returned that indicate the values since the last .get() call, and the
 *   metrics will be reset.
 *
 *
 *   The second mechanism exposed by this module is the ability to run a handler
 *   function on every sampling of the eventloop data. The sampling happens
 *   every pollFrequencyMs (this option can be passed to the constructor to
 *   override the default of 500 ms). To register a handler one can either:
 *
 *     var eventloopMetrics = new EventloopMetrics({[pollFrequencyMs: 500]});
 *     eventloopMetrics.start(<handleFn>);
 *
 *   or:
 *
 *     var eventloopMetrics = new EventloopMetrics({[pollFrequencyMs: 500]});
 *     eventloopMetrics.start();
 *     // <do something>
 *     eventloopMetrics.setHandler(<handleFn>);
 *
 *   in either case, once set, the handleFn will be called:
 *
 *     handleFn(sampleObj);
 *
 *   every time a sample is collected. The sampleObj will look like:
 *
 *     {
 *         loopCount: <Number>,   // number of eventloop executions this sample
 *         loopTimeMax: <Number>, // max eventloop time observed this sample
 *         loopTimeMin: <Number>, // min eventloop time observed this sample
 *         loopTimeSum: <Number>, // total eventloop time observed this sample
 *         lag: <Number>          // lag for this sample's setTimeout()
 *    }
 *
 *  the lag, and loopTime* values are reported in nanoseconds.
 *
 *
 * Notes:
 *
 *   * Due to the issue described in:
 *
 *     https://github.com/nodejs/node/issues/10154

 *     the lag here might end up being up to 1ms ahead of the target delay. So
 *     it is possible for lag to be a negative value.
 *
 *   * To unset a handleFn, it is possible to call:
 *
 *       eventloopMetrics.setHandler(undefined);
 *
 *   * There can only be one handleFn assigned, and that function will run
 *     frequently and sychronously, so it should not do too much work or it
 *     will cause performance issues in your application.
 *
 *   * In order to stop the looping of the handler, it is possible to call:
 *
 *       eventloopMetrics.stop();
 *
 *   * All time values returned, and all time values handled internally (except
 *     the pollFrequencyMs) are used in nanoseconds (and converted if
 *     necessary). This is to avoid precision problems with Javascript numbers.
 */

var assert = require('assert-plus');
var eventLoopStats = require('event-loop-stats');

var DEFAULT_EVENTLOOP_POLL_MS = 500;
var MS_PER_SECOND = 1e3;
var NS_PER_SECOND = 1e9;
var NS_PER_MS = NS_PER_SECOND / MS_PER_SECOND;

// Convert a process.hrtime() diff Array into a (returned) number of nanoseconds.
function deltaToNanoSecs(delta) {
    return delta[0] * NS_PER_SECOND + delta[1];
}

function EventloopMetrics(opts) {
    var self = this;

    if (opts === undefined) {
        opts = {};
    }

    assert.object(opts, 'opts');
    assert.optionalNumber(opts.pollFrequencyMs, 'opts.pollFrequencyMs');

    self.data = {};
    self.pollFrequencyMs = opts.pollFrequencyMs || DEFAULT_EVENTLOOP_POLL_MS;

    // initialize the .data variables
    self.reset();

    // Set true when we're .stop()ing so we don't start another timer.
    self.stopAsap = false;
}

EventloopMetrics.prototype.reset = function reset() {
    var self = this;

    self.minLoopCount = Number.MAX_SAFE_INTEGER;
    self.maxLoopCount = Number.MIN_SAFE_INTEGER;
    self.maxLag = Number.MIN_SAFE_INTEGER;
    self.maxTime = Number.MIN_SAFE_INTEGER;
    self.minLag = Number.MAX_SAFE_INTEGER;
    self.minTime = Number.MAX_SAFE_INTEGER;
    self.sampleCount = 0;
    self.sumLag = 0;
    self.sumLoopCount = 0;
    self.sumTime = 0;
};

EventloopMetrics.prototype.updateEventloopData = function updateEventloopData() {
    var self = this;

    var expectedDeltaNanoSeconds = self.pollFrequencyMs * NS_PER_MS;
    var start = process.hrtime();

    if (self.stopAsap) {
        // Don't start another timer if we're trying to stop.
        return;
    }

    self.timer = setTimeout(function _measureEventloopLag() {
        var sample = {}; // data from *this* run
        var stats;
        var timeoutDeltaNanoSecs = deltaToNanoSecs(process.hrtime(start));

        // Load the data provided by event-loop-stats
        stats = eventLoopStats.sense();
        sample.loopCount = stats.num;
        sample.loopTimeMax = stats.max * NS_PER_MS;
        sample.loopTimeMin = stats.min * NS_PER_MS;
        sample.loopTimeSum = stats.sum * NS_PER_MS;

        // Subtract the time we expected it to take to run the timer, from
        // the time it actually took. Use this value as "lag".
        //
        // Note: due to the issue described in:
        //
        // https://github.com/nodejs/node/issues/10154
        //
        // the lag here might end up being up to 1ms ahead of where it should
        // be. (i.e. lag = -0.001)
        sample.lag = timeoutDeltaNanoSecs - expectedDeltaNanoSeconds;

        // Schedule the next update
        setImmediate(function _measureEventloopTime() {
            // If a handlerFn is set, we'll call it and pass in the raw data.
            // This could be used to implement something like:
            //
            //   https://github.com/lloyd/node-toobusy
            //
            if (self.handlerFn !== undefined) {
                self.handlerFn(sample);
            }

            // Now we update the data available for .get()
            self.sampleCount++;
            self.maxLag = Math.max(self.maxLag, sample.lag);
            self.minLag = Math.min(self.minLag, sample.lag);
            self.sumLag += sample.lag;
            self.maxLoopCount = Math.max(self.maxLoopCount, sample.loopCount);
            self.minLoopCount = Math.min(self.minLoopCount, sample.loopCount);
            self.sumLoopCount += sample.loopCount;
            self.maxTime = Math.max(self.maxTime, sample.loopTimeMax);
            self.minTime = Math.min(self.minTime, sample.loopTimeMin);
            self.sumTime += sample.loopTimeSum;

            // This will do a new setTimeout and start the loop again. We don't
            // use a setInterval() because of the potential case where the lag
            // is large and greater than or close to the interval.
            self.updateEventloopData();
        });
    }, self.pollFrequencyMs);
};

EventloopMetrics.prototype.get = function get() {
    var self = this;

    // do a reset after we return
    process.nextTick(self.reset.bind(self));

    // If we've not got samples, set min+max to 0
    if (self.sampleCount === 0) {
        self.maxLag = self.minLag = self.sumLag = 0;
    }
    if (self.sumLoopCount === 0) {
        self.maxLoopCount = self.minLoopCount = self.sumLoopCount = 0;
        self.maxTime = self.minTime = self.sumTime = 0;
    }

    return {
        sampleCount: self.sampleCount,
        lagMax: self.maxLag,
        lagMin: self.minLag,
        lagSum: self.sumLag,
        loopCountMax: self.maxLoopCount,
        loopCountMin: self.minLoopCount,
        loopCountSum: self.sumLoopCount,
        loopTimeMax: self.maxTime,
        loopTimeMin: self.minTime,
        loopTimeSum: self.sumTime
    };
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
