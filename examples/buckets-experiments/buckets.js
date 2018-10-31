/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

// Run with buckets as args and a file full of numbers (one per line) on stdin.
//
// E.g.:
//
// node examples/buckets.js 0.1 0.5 1 < myfile.txt
//

var readline = require('readline');

var assert = require('assert-plus');

var argv = process.argv;

// This holds the data very gently.
function DataBox(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.array(opts.buckets, 'opts.buckets');

    var idx;

    self.buckets = opts.buckets;
    self.promData = {
        sum: 0,
        '+Inf': 0
    };

    for (idx = 0; idx < self.buckets.length; idx++) {
        self.promData[self.buckets[idx]] = 0;
    }
}

DataBox.prototype.addDatum = function addDatum(value) {
    var self = this;
    var idx;

    // Basically mimicks how prometheus does bucketing
    // update every bucket that's > value, and then update sum and +Inf
    for (idx = 0; idx < self.buckets.length; idx++) {
        if (value <= self.buckets[idx]) {
            self.promData[self.buckets[idx]]++;
        }
    }
    self.promData['+Inf']++;
    self.promData.sum += value;
};

function main() {
    var buckets = [];
    var dataBox;
    var idx;
    var num;
    var rl;

    // Setup Buckets
    while (!Number.isNaN(num = Number(argv.pop()))) {
        buckets.unshift(num);
    }
    buckets.sort(function _sortBuckets(a, b) { return (a - b); });

    // Create the first DataBox
    dataBox = new DataBox({buckets: buckets});

    // Read all the data
    rl = readline.createInterface({
        crlfDelay: Infinity,
        input: process.stdin,
        terminal: false
    });

    rl.on('line', function _processLine(line) {
        var chunks = line.split(' ');
        var val;

        if (chunks.length === 1) {
            val = Number(chunks[0]) / 1000; // input is a set of numbers in ms
        } else if (chunks.length === 2) {
            val = Number(chunks[1]) / 1000; // input is a set of timestamps followed numbers in ms
        }

        assert.number(val, '"' + val + '" should have been a number');
        dataBox.addDatum(val);
    });

    rl.on('close', function finalProcessing() {
        // Dump the data
        for (idx = 0; idx < buckets.length; idx++) {
            console.log('%d\t%d', buckets[idx], dataBox.promData[buckets[idx]]);
        }
        console.log('+Inf\t%d', dataBox.promData['+Inf']);
    });
}


// Call main
main();
