# Histogram Bucket Experiments

## What's this?

This directory contains experimental code to try to determine how well a given
set of histogram buckets for Prometheus would fit our data when used with
`histogram_quantile`.

In order to run these experiments, you'll need data files that contain a list of
values with a single number per line. For example, if you're trying to evaluate
the fit for the `http_request_duration_seconds` and pulling your data from the
bunyan logs, the input files should contain a series of numbers, one per line
representing the amount of time spent processing requests (this code currently
assumes milliseconds as input).

Example input file:

```
336
42
73
67
130
157
174
153
138
```

We'll call this file `input.txt` here. You then need a JSON file specifying the
bucket data. The values used for our initial experiments are in the schemes/
subdirectory. The JSON files should look something like:

```
{
    "buckets": [
        0.005, 0.01,
        0.025, 0.05, 0.1,
        0.25, 0.5, 1,
        2.5, 5, 10
    ],
    "description": "node-artedi v2 default buckets",
    "key": "artedi_v2_defaults"
}
```

with the buckets array here representing the upper boundary (`le` label in
Prometheus) for each bucket. We'll use this file `schemes/artedi_v2_default.json` here.

## Setup

Before you can run the experimental sample through our simulator, you'll need to
setup your environment. The easiest way to do this is to run:

```
mkdir -p node_modules && npm isntall tabula assert-plus
```

once you've installed these prerequisites, you can move on to the experiments.

## Running an experiment

To run our input file through the experimental simulator, we can run:

```
$ ./runner-debug.sh input.txt schemes/artedi_v2_default.json
# BUCKETS: [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10]
# CHUNK_SIZE: 100000
# CHUNK 0
# first 10: 0.336, 0.042, 0.073, 0.067, 0.13, 0.157, 0.174, 0.153, 0.138
# P99.9 actual: 0.174, prometheus: 0.4977, error: 186.06
# P99 actual: 0.174, prometheus: 0.4775, error: 174.43
# P98 actual: 0.174, prometheus: 0.455, error: 161.49
# P95 actual: 0.174, prometheus: 0.3875, error: 122.7
# P75 actual: 0.153, prometheus: 0.2125, error: 38.89
# P50 actual: 0.13, prometheus: 0.145, error: 11.54
# P25 actual: 0.067, prometheus: 0.0813, error: 21.27


# SUMMARY
#
# BUCKETS(11)
#
#      0.005 0.01
#      [0.01] 0.025 0.05 0.1
#      [0.1] 0.25 0.5 1
#      [1] 2.5 5 10
#      [10]
#
#       /-------- ERROR --------\     /------- ACTUAL -------\      /----- PROMETHEUS -----\
%ILE    MIN%      MAX%      AVG%      MIN       MAX       AVG       MIN       MAX       AVG
P99.9   186.06    186.06    186.06    0.174     0.174     0.17      0.498     0.498     0.5
P99     174.43    174.43    174.43    0.174     0.174     0.17      0.478     0.478     0.48
P98     161.49    161.49    161.49    0.174     0.174     0.17      0.455     0.455     0.46
P95     122.7     122.7     122.7     0.174     0.174     0.17      0.387     0.387     0.39
P75     38.89     38.89     38.89     0.153     0.153     0.15      0.212     0.212     0.21
P50     11.54     11.54     11.54     0.13      0.13      0.13      0.145     0.145     0.15
P25     21.27     21.27     21.27     0.067     0.067     0.07      0.081     0.081     0.08
# data points: 9, chunk size: 100000, chunks: 1, total elapsed (s): 0.014010881
# Description: node-artedi v2 default buckets
$
```

the output here is pretty verbose. Unless you're debugging the tool itself, you
can ignore the first part and focus on the SUMMARY section. The first thing here
is a re-output of the buckets we're using. Bundled together by base-10
magnitude. The values in the square brackets are duplicated from the previous
line in attempt to make it clearer what's going on. With Prometheus values are
always `<=` the bucket value, so in this case for example while 0.1 is
technically in the 10^-1 magnitude, the values 0.05 to 0.1 are all in the 0.1
bucket, so it really also belongs on the previous line. The value will only
actually appear once in the array that we actually use. This notation is just
for display to humans.

The last section is where all the data is. The `%ILE` column should be pretty
straight-forward. This is the percentile that the rest of the row represents.
P99 for example means the value (from input.txt here) below which 99% of other
values fall.

While the `ERROR` values come first, I'll talk about the `ACTUAL` section first.
The `ACTUAL` values are calculated by taking the set of inputs (in chunks, but
that's discussed below) and sorting them. It then finds the value at the index
that's `length * 0.99` for the P99 value. So if there were 1000 inputs, the P99
value would be the 990th value. Because we're using 0-indexed arrays this
actually means the `sorted_inputs[989]` value in Javascript terms. We show this
value as MIN/MAX/AVG which is the minimum, maximum and average of all the
different chunks processed (again more on chunks below).

Now that we know about the `ACTUAL` values, the last columns are for the
`PROMETHEUS` values. These are calculated using the buckets provided. Basically
the inputs are all placed in cumulative buckets like those that prometheus uses,
and the quantile value is calculated in the same manner Prometheus would
calculate the `histogram_quantile` value for the resulting buckets. Once again
the MIN/MAX/AVG are the minimum, maximum and average of the values for all the
chunks.

The first columns `ERROR` represent the MIN/MAX/AVG error in the prometheus
value as compared to the `ACTUAL` value. In this case for example with the P99.9
value we had a MAX% error of 186.06. This means the value for `PROMETHEUS` was
186.06% different from the `ACTUAL` value. With these buckets, we calculated
0.4977 as the `PROMETHEUS` value but the `ACTUAL` P99.9 value was 0.174. The
error is calculated as:

```
Math.abs(1 - (Math.max(prometheus, actual) / Math.min(prometheus, actual))) * 100
```

so here, the absolute value of:

```
(1 - (0.4977 / 0.174)) * 100 = -186.06
```

or 186.06% error compared to the known-correct quantile value.

## Chunks

Because we want to be able to run these experiments on very large datasets in
order to test the widest range of inputs, we cannot put the entire dataset in
memory at once. As such, we read the input in chunks. By default we read in
100,000 line chunks. But you can add a 3rd parameter to the `runner-debug.sh`
command in order to run with alternative sized chunks. For example:

```
$ ./runner-debug.sh input.txt schemes/artedi_v2_default.json 200
```

would cause input to be read in 200k chunks instead of 100k chunks.

Each chunk is processed and the results for that chunk are output (the debug
output above the summary includes lines for each of these chunks) and then once
all chunks have been processed, the `SUMMARY` is generated by finding the
minimum, maximum and average values for the different properties described in
the previous section. So a MAX value for PROMETHEUS of 0.498 for P99.9 means
from all the different chunks, that was the highest quantile value calculated.

## What this tool was used for

This tool was created so that we could attempt to determine the best bucket
values to use for our histograms using the new node-artedi v2 feature that
allows us to pass in custom buckets.

We created several different sets of buckets and ran them against all the data
from one of our clouds for September 2018 for:

 * cloudapi
 * cnapi
 * fwapi
 * napi
 * sapi
 * ufds
 * vmapi

where the input files were generated by pulling the request latency values from
the logs stored in Manta.

We ran all the different sets of buckets across each of the different datasets
and analyzed the results in terms of min/max/avg error from the actual quantile
values.

Some of the buckets were created using the artedi logLinearBuckets() function.
Others were hand crafted based on observations of the data. The goals were to:

 * try to choose buckets the error rates as low as possible (arbitrarily chosen P95 target for comparison)
 * try to choose as few unique buckets as possible since having more buckets will improve accuracy but decrease performance
 * we'd like to eventually have SLI values as buckets, so the bucket numbers would ideally be something that humans will recognize as "nice round numbers"
 * having more buckets close together in the range where most of the values are, will allow us to generate useful heatmaps with grafana
 * we'd like to have the same set of buckets for all Triton APIs if feasible (since then we can compare them directly)

We ran the same data in 100k, 200k and 500k (these numbers chosen arbitrarily)
so that we'd not end up with results that only applied to one specific subset of
the data.


## Problems with the above, and a new attempt

The first attempts at calculating error (described above) naively ran the
Prometheus quantile across large chunks of data, but this actually does not
match what we're usually doing when we use `histogram_quantile` in graphs in
Grafana. Usually we're doing a `histogram_quantile` on a `rate`. So this
section explains what is required to calculate this way and what the initial
results were.

Here we'll assume a very simple set of buckets:

```
[ 0.25, 0.5, 1, 2.5 ]
```

to make it easy to illustrate what's going on.

If we take the values, lets say here:

```
2018-09-01T00:00:01.590Z 0.268
2018-09-01T00:00:01.802Z 0.259
2018-09-01T00:00:02.036Z 0.184
2018-09-01T00:00:02.347Z 0.256
2018-09-01T00:00:02.499Z 1.362
2018-09-01T00:00:02.654Z 1.932
2018-09-01T00:00:02.686Z 1.626
```

And pretend these were the only values we saw in a 15s interval (to make things
easy, we'll use the interval 00:00:00 - 00:00:15)... What we'll do is bucketize
those values for that 15s period like:

```
0.25 1
0.5  4
1    4
2.5  7
+Inf 7
```

And that's the sample prometheus would see when it runs at 00:00:15. Then if we
get another set of data for the next period (00:00:15 - 00:00:30) that looks
exactly the same, just offset 15s:

```
2018-09-01T00:00:16.590Z 0.268
2018-09-01T00:00:16.802Z 0.259
2018-09-01T00:00:17.036Z 0.184
2018-09-01T00:00:17.347Z 0.256
2018-09-01T00:00:17.499Z 1.362
2018-09-01T00:00:17.654Z 1.932
2018-09-01T00:00:17.686Z 1.626
```

Again pretending these are the only values in this 15s period, we'll *add* those
to the existing buckets (since prometheus histograms are cumulative) and have:

```
0.25 2
0.5  8
1    8
2.5  14
+Inf 14
```

when prometheus scrapes its second sample.

In order to simulate the query:

```
histogram_quantile(0.95, sum(rate(myHistogram[5m])) by (le))
```

we can actually ignore the sum() for our purposes, since we don't have any extra
labels such as route, user-agent, etc. So we will get the same results with:

```
histogram_quantile(0.95, rate(myHistogram[5m]))
```

To calculate the rate after we've made our two samples what Prometheus does is
take the first and last sample that it can find in the 5m window. Since we only
have 2, this is easy. It then looks at the time difference between these points
and the ends of the 5 minute window.

To make it easy, lets say we run the query at 00:05:00. This means the 5 minute
window is from 00:00:00 to 00:05:00. Our first sample was collected at 00:00:15,
so 15 seconds after the time 0 for the window. The last sample was collected at
00:00:30 so 270 seconds before the end of the window.

Having our samples at the beginning of the range also allows us to ignore the
code that detects where the "0 point" is for the value (based on the slope). If
it determines that the 0 point is after the rangeStart, calculations start at
the 0 point rather than the actual start so that no counter needs to be
negative.

To help match this up with [the code](https://github.com/prometheus/prometheus/blob/f34b2602e1208b75dfa9ab17c81dd086fc92f54a/promql/functions.go#L60-L139),
we'll use the same variable names here. So far we have:

```
rangeStart = 00:00:00
rangeEnd = 00:05:00
durationToStart = 15
durationToEnd = 270
```

It calculates the sampledInterval as the time of the last sample minus the time
of the first sample. In our case this means 15s.

It calculates the averageDurationBetweenSamples with the formula:

```
averageDurationBetweenSamples = sampledInterval / (number of samples - 1)
```

Since we have 2 samples here, we end up with 15s again.

Next it calculates a threshold which determines whether we're too far away from
the "ends" of this range and need to extrapolate or whether we can just assume
there was a single additional point. This calculation is simply:

```
extrapolationThreshold = averageDurationBetweenSamples * 1.1;
```

so after this our variables look like:

```
rangeStart = 00:00:00
rangeEnd = 00:05:00
durationToStart = 15
durationToEnd = 270
sampledInterval = 15
averageDurationBetweenSamples = 15
extrapolationThreshold = 16.5
```

We can also run through:

```
extrapolateToInterval = sampledInterval;

if (durationToStart < extrapolationThreshold) {
    extrapolateToInterval += durationToStart;
} else {
    extrapolateToInterval += averageDurationBetweenSamples / 2;
}
if (durationToEnd < extrapolationThreshold) {
    extrapolateToInterval += durationToEnd;
} else {
    extrapolateToInterval += averageDurationBetweenSamples / 2;
}
```

which won't change between buckets in our case. Giving us:

```
rangeStart = 00:00:00
rangeEnd = 00:05:00
durationToStart = 15
durationToEnd = 270
sampledInterval = 15
averageDurationBetweenSamples = 15
extrapolationThreshold = 16.5
extrapolateToInterval = 37.5; // 15 + 15 (for durationToStart) + 7.5 (for durationToEnd)
```

We don't need to worry about resets (counters going back to 0) or negative
numbers here, so we can skip the code that deals with those. So the above lists
all the variables that are common for all buckets. We then need to go through
and do some calculations for each bucket. This is because the rate function will
return a separate result for each bucket.

We'll just do the calculations here for the 0.25 bucket, but they would work the
same for the others. For each bucket we do basically:

```
// we divide by 300 to get from seconds to a per-second value for this range
resultValue = ((last sample - first sample) * (extrapolateToInterval / sampledInterval)) / 300;
```

in the case of the 0.25 bucket here, we're looking at:

```
resultValue = 2 - 1; // = 1
resultValue = 1 * (37.5 / 15); // 2.5
resultValue = 2.5 / 300; // 0.00833...
```

So our result for this bucket is 0.00833... After calculating for the other
buckets the same way, we'll end up with:

```
{le="0.25"} 0.00833...
{le="0.5"} 0.03155...  // ((8 - 4) * (35.5 / 15)) / 300
{le="1"} 0.03155...  // ((8 - 4) * (35.5 / 15)) / 300
{le="2.5"} 0.05522... // ((14 - 7) * ((35.5 / 15)) / 300
{le="+Inf"} 0.05522... // ((14 - 7) * ((35.5 / 15)) / 300
```

which represent what prometheus thinks is the per-second increase in these
different values. Having samples closer to the ends of the range will make
things more accurage since here we're losing a lot of accuracy due to the
inability to extrapolate.

Back to our original query:

```
histogram_quantile(0.95, rate(myHistogram[5m]))
```

we'd now be running that on the data:

```
{le="0.25"} 0.00833
{le="0.5"} 0.03155
{le="1"} 0.03155
{le="2.5"} 0.05522
{le="+Inf"} 0.05522
```

which will give us a value somewhere between 1 and 2.5 (because 100% of our
values were less than 2.5 and around 57% (0.03155 / 0.05522) were less than 1.

We're only using the per-second rate here to show the relative increases
in the different buckets, the actual value returned by `histogram_quantile` is
the *le* value which is directly related to the inputs. So a P95 of these rates
should be approximately the same as a P95 of the underlying values.

Unfortunately there are some cases where that's not going to be true however.
One example is if there is a single large outlier in an otherwise normal set of
data. One case I've seen is where the (sorted) values for the 5m period ended
with:

```
  1.227,
  1.241,
  1.261,
  1.278,
  1.283,
  1.637,
  3600.042
```

So the largest value here is 3600.042 but in this array there are actually 1149
data points. So the true P99.9 is going to be 1.283. But with the
rates, we ended up with:

```
...
  "0.1": 1.5157894736842104,
  "0.2": 1.726315789473684,
  "0.3": 1.926315789473684,
  "0.4": 2.3298245614035085,
  "0.5": 2.621052631578947,
  "0.6": 2.764912280701754,
  "0.7": 2.880701754385965,
  "0.8": 3.0807017543859647,
  "0.9": 3.2105263157894735,
  "1": 3.2771929824561403,
  "2": 3.350877192982456,
...
  "80": 3.350877192982456,
  "90": 3.350877192982456,
  "100": 3.350877192982456,
  "200": 3.350877192982456,
  "300": 3.350877192982456,
  "400": 3.350877192982456,
  "500": 3.350877192982456,
  "600": 3.350877192982456,
  "700": 3.350877192982456,
  "800": 3.350877192982456,
  "900": 3.350877192982456,
  "1000": 3.350877192982456,
  "2000": 3.350877192982456,
  "3000": 3.350877192982456,
  "4000": 3.3543859649122805,
  "+Inf": 3.3543859649122805
```

So when we take a histogram of the rates here, prometheus calculates a rank of:

```
3.3543859649122805 * 0.999 = 3.3510315789473682
```

which puts it into the 4000 bucket. As you can see the difference between that
bucket and the "2" bucket (where the actual value should have been) is only
0.00350877193 which is not much. So a little bit of lost precision here due to
the way Prometheus calculates things has made a drastic difference in the
result. Here the actual correct value is 1.283 but prometheus calculates 3044
which is an error of 237156.43%.

## Conclusions

The fact that much of the error here and in many of the other samples that were
investigated came from the way Prometheus handles data rather than from the
buckets themselves, means that it's probably not possible to just use the error
percentages we've calculated in order to make good decisions about buckets.

Instead, after much effort, it seems we're likely going to be better off using
the results so far as some very general datapoints in bucket selection, and
potentially using some of this information that was gathered in order to debug
problems if they're seen in the future.

I think the most likely situation is that whatever buckets we choose, we'll find
that we want to change them in the future. So it seems best to just choose some
that seem reasonable for now, and let our experiences guide changes to these
buckets in the future. We've discussed adding support for a `buckets_version`
label in the future which could allow us to change buckets without having to
drop all existing data.

The way I imagine future buckets changes to come about is due to someone
comparing the histogram data to some other known-correct data (logs, dtrace,
experiments, etc) and finding that the histogram is showing features that are
not there, or not showing features that should be there. At that point isolating
the specific issue and potentially adding buckets to increase the resolution and
avoid the issue might make sense.

One other conclusion I've reached while going through these experiments is that
with the current rate of outliers, P99.9 is mostly useless from an accuracy
standpoint. P99 is *much* more accurate. Though P99.9 can be useful if we wish
to have giant spikes whenever there's an outlier, despite that not being an
accurate representation of P99.9.

