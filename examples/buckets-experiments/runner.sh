#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Copyright (c) 2018, Joyent, Inc.
#

set -o errexit
if [[ -n ${TRACE} ]]; then
    set -o xtrace
fi

infile=$1
jsonfile=$2

if [[ ! -f $infile || ! -f $jsonfile ]]; then
    echo "Usage: $0 <infile> <jsonfile>" >&2
    exit 2
fi

json=$(/usr/bin/json < $jsonfile)
buckets=$(json -e "this.strbuckets = this.buckets.join(' ')" strbuckets <<<"${json}")
description=$(json description <<<"${json}")
key=$(json key <<<"${json}")
file=$(basename ${infile})

if [[ -z ${buckets} || -z ${description} || -z ${key} ]]; then
    echo "Bad JSON in ${jsonfile}" >&2
    exit 2
fi

for range in 100 200 500; do
    (
        (CHUNK_SIZE=${range}000 node ./error-estimator.js \
            ${buckets} > output/${file}.${key}.${range}k.out 2>&1) < ${infile}
        echo "# Description: ${description}" >> output/${file}.${key}.${range}k.out
    ) &
done

wait
