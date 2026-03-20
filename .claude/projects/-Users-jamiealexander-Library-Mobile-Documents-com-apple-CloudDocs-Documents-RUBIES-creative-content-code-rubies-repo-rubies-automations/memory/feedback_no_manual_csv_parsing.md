---
name: Never manually parse CSV data
description: Always pass raw CSV directly to parse_wholesale_input tool — never manually count columns or eyeball comma-separated values
type: feedback
---

Never manually parse CSV matrix data by counting commas or eyeballing column positions. Always pass the raw CSV (including header row) directly to `parse_wholesale_input`, which programmatically maps headers to column indices.

**Why:** Manual comma-counting caused an off-by-one error on a wholesale order for Illusions Lingerie, assigning quantities to wrong sizes. This is a critical business error — wrong sizes shipped to wholesale customers.

**How to apply:** When the user provides a CSV file for a wholesale order, read the file with the Read tool and pass the entire contents (header + data rows) directly to `parse_wholesale_input`. Do not attempt to interpret or reformat the CSV yourself.
