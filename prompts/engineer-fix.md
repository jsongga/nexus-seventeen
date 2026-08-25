Fix round {{round}} on branch {{branch}}. A reviewer found the defects below; the diff is on the branch. Fix each finding, then re-trace the whole flow end to end — not just the patch. Loop: run `npm run verify:fast`, read the failure, fix; repeat until green. Run `npm run verify:area` once before finishing. Commit in staged logical units. The declared scope, non-goals, and BRIGHT_LINE rules from the original task still apply verbatim.
Review findings:
{{findings}}
{{brightLine}}
