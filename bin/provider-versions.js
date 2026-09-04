#!/usr/bin/env node
"use strict";

const {
  getProvider,
  getProviderVersionSync,
  providerIds,
} = require("../lib/providers");

for (const id of providerIds()) {
  const provider = getProvider(id);
  const version = getProviderVersionSync(provider);
  console.log(`${provider.label}: ${version || "unavailable"}`);
}
