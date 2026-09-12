# Ralphex ISO plan filename dates

## Goal

Use the readable, lexicographically sortable ISO date format `yyyy-MM-dd` in newly created plan filenames.

## Design

Both interactive plan saving and autonomous Ralphex plan generation will produce `docs/plans/yyyy-MM-dd-<slug>.md`. Numeric collision suffixes remain unchanged. Documentation and tests will use the same format.

Existing plans remain compatible: Ralphex will continue accepting legacy `yyyyMMdd-<slug>.md` filenames, while execution branch derivation will recognize both legacy and ISO prefixes. Loop and review workflows will not rename existing files.

## Validation

Run the existing toolkit test suite with `npm test`.
