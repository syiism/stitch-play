#! /bin/env bash

set -e

PORT=${1:8099}

python "tools/server.py" $PORT > stitch-play.log &

echo "The server is running on http://0.0.0.0:$PORT"