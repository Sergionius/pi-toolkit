# English plan and branch names

## Decision

Use model-authored `<!-- plan-slug: meaningful-english-name -->` metadata for new plans. Translate the task meaning rather than transliterating a localized title or copying a backlog filename. Keep titles and prose localized. Apply the same rule to new backlog filenames.

## Implementation

Share naming instructions and syntax validation between conversational Plan Mode, Ralphex planning, and autonomous planning. Remove both Cyrillic transliteration tables. Prefer metadata for execution branch names. Localized drafts without metadata fail with an actionable message; autonomous validation feeds that error into its existing retry mechanism. Preserve compatibility for English legacy drafts and filenames, without automatically renaming saved files or existing branches.

No new model request is needed when saving a plan. A character sanitizer cannot translate meaning or reliably distinguish ASCII transliteration from English: semantic naming is the planning model's responsibility, while code validates the slug syntax and length.

## Scope

Do not change branch-selection consent: interactive execution offers a branch on main/master/trunk, and auto continues on the current branch. Test both paths and legacy-name metadata overrides, collision-safe saving, and invalid metadata.
