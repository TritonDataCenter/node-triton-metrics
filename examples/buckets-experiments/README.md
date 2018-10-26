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

