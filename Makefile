#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

#
# Makefile
#

ESLINT = ./node_modules/.bin/eslint
JSFILES := $(shell find lib test -name '*.js')
PRETTIER = ./node_modules/.bin/prettier
TAP = ./node_modules/.bin/tape


all $(ESLINT) $(PRETTIER):
	npm install

.PHONY: clean
clean:
	rm -rf node_modules

.PHONY: check
check:: check-version check-eslint check-prettier
	@echo "Check ok."

.PHONY: check-eslint
check-eslint: | $(ESLINT)
	$(ESLINT) $(JSFILES)

.PHONY: check-prettier
check-prettier: | $(PRETTIER)
	@echo "# Checking formatting. Re-run 'make fmt' if this fails."
	$(PRETTIER) --list-different $(JSFILES)

.PHONY: fmt
fmt: | $(ESLINT)
	$(ESLINT) --fix $(JSFILES)

# Ensure CHANGES.md and package.json have the same version.
.PHONY: check-version
check-version:
	@echo version is: $(shell cat package.json | json version)
	[[ `cat package.json | json version` == `grep '^## ' CHANGES.md | head -2 | tail -1 | awk '{print $$2}'` ]]

.PHONY: cutarelease
cutarelease: check-version
	[[ -z `git status --short` ]]  # If this fails, the working dir is dirty.
	@which json 2>/dev/null 1>/dev/null && \
	    ver=$(shell json -f package.json version) && \
	    name=$(shell json -f package.json name) && \
	    publishedVer=$(shell npm view -loglevel silent -j $(shell json -f package.json name)@$(shell json -f package.json version) version 2>/dev/null) && \
	    if [[ -n "$$publishedVer" ]]; then \
		echo "error: $$name@$$ver is already published to npm"; \
		exit 1; \
	    fi && \
	    echo "** Are you sure you want to tag and publish $$name@$$ver to npm?" && \
	    echo "** Enter to continue, Ctrl+C to abort." && \
	    read
	ver=$(shell cat package.json | json version) && \
	    date=$(shell date -u "+%Y-%m-%d") && \
	    git tag -a "v$$ver" -m "version $$ver ($$date)" && \
	    git push --tags origin && \
	    npm publish

.PHONY: git-hooks
git-hooks:
	ln -sf ../../tools/pre-commit.sh .git/hooks/pre-commit

.PHONY: test
test: $(TAPE)
		TAP=1 $(TAP) test/*.test.js
