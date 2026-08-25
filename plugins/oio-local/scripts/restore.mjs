#!/usr/bin/env node

import { holdResult } from "../lib/journey.mjs";
import { restoreBackup } from "../lib/recovery.mjs";

const values = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value.replace(/^--/u, ""), all[index + 1]]);
    return pairs;
  }, []),
);
try {
  process.stdout.write(`${JSON.stringify(await restoreBackup({
    destination: values.destination,
    source: values.source,
  }))}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(holdResult(error, values.language ?? "en"))}\n`);
  process.exitCode = 2;
}
