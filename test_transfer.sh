#!/bin/bash

# Test script for verifying file transfer functionality
# Usage: ./test_transfer.sh <file_to_upload>

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVER_URL="https://shuttle-piping-8zed.shuttle.app"
TRANSFER_ID="file-transfer-test-$(date +%s)"

if [ "$#" -ne 1 ]; then
    echo -e "${RED}Error: Missing file argument${NC}"
    echo "Usage: $0 <file_to_upload>"
    exit 1
fi

FILE_PATH="$1"

if [ ! -f "$FILE_PATH" ]; then
    echo -e "${RED}Error: File not found: $FILE_PATH${NC}"
    exit 1
fi

ORIGINAL_SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH")
echo -e "${YELLOW}Original file size: $ORIGINAL_SIZE bytes ($(echo "scale=2; $ORIGINAL_SIZE/1024/1024" | bc) MB)${NC}"

# Temporary download path
DOWNLOAD_PATH="/tmp/downloaded_$(basename "$FILE_PATH")"

echo -e "${YELLOW}Starting file transfer test...${NC}"
echo "Transfer ID: $TRANSFER_ID"
echo "Server: $SERVER_URL"

# Start receiver in background
echo -e "${YELLOW}Starting receiver...${NC}"
curl -s "$SERVER_URL/$TRANSFER_ID" > "$DOWNLOAD_PATH" &
RECEIVER_PID=$!

# Wait a moment for receiver to connect
sleep 2

# Upload file
echo -e "${YELLOW}Starting upload...${NC}"
UPLOAD_RESULT=$(curl -T "$FILE_PATH" "$SERVER_URL/$TRANSFER_ID" 2>&1)
echo "Upload result: $UPLOAD_RESULT"

# Wait for receiver to finish
wait $RECEIVER_PID

# Verify downloaded file
if [ ! -f "$DOWNLOAD_PATH" ]; then
    echo -e "${RED}✗ FAILED: Downloaded file not found${NC}"
    exit 1
fi

DOWNLOADED_SIZE=$(stat -f%z "$DOWNLOAD_PATH" 2>/dev/null || stat -c%s "$DOWNLOAD_PATH")
echo -e "${YELLOW}Downloaded file size: $DOWNLOADED_SIZE bytes ($(echo "scale=2; $DOWNLOADED_SIZE/1024/1024" | bc) MB)${NC}"

# Compare sizes
if [ "$ORIGINAL_SIZE" -eq "$DOWNLOADED_SIZE" ]; then
    echo -e "${GREEN}✓ SUCCESS: File sizes match!${NC}"

    # Verify content integrity
    if command -v md5sum &> /dev/null; then
        ORIGINAL_MD5=$(md5sum "$FILE_PATH" | awk '{print $1}')
        DOWNLOADED_MD5=$(md5sum "$DOWNLOAD_PATH" | awk '{print $1}')
    else
        ORIGINAL_MD5=$(md5 -q "$FILE_PATH")
        DOWNLOADED_MD5=$(md5 -q "$DOWNLOAD_PATH")
    fi

    if [ "$ORIGINAL_MD5" == "$DOWNLOADED_MD5" ]; then
        echo -e "${GREEN}✓ SUCCESS: File content integrity verified (MD5: $ORIGINAL_MD5)${NC}"
        rm "$DOWNLOAD_PATH"
        exit 0
    else
        echo -e "${RED}✗ FAILED: File content mismatch${NC}"
        echo "Original MD5: $ORIGINAL_MD5"
        echo "Downloaded MD5: $DOWNLOADED_MD5"
        exit 1
    fi
else
    echo -e "${RED}✗ FAILED: File size mismatch${NC}"
    echo "Expected: $ORIGINAL_SIZE bytes"
    echo "Got: $DOWNLOADED_SIZE bytes"
    echo "Missing: $((ORIGINAL_SIZE - DOWNLOADED_SIZE)) bytes"
    exit 1
fi
