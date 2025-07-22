#!/bin/bash

if [[ "$CLONE_URI" == *"?branch="* ]]; then
    BRANCH_NAME=$(echo $CLONE_URI | sed 's/.*?branch=//')
    BASE_URI=$(echo $CLONE_URI | sed 's/?branch=.*//')
    echo "Cloning branch $BRANCH_NAME from $BASE_URI"
    git clone -b $BRANCH_NAME $BASE_URI
else
    echo "Cloning default branch from $CLONE_URI"
    git clone $CLONE_URI
fi

REPO_NAME=$(basename ${CLONE_URI%\?*} .git)
echo "Repo name: $REPO_NAME"
cd $REPO_NAME

npx agent run
