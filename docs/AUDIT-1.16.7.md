# Ecosystem audit, release 1.16.7 (2026-11-13)

Scope: every financial screen and every printed document, held against the ledger and against each other.
Method: one scenario with known answers is built through the API, each screen's own engine is read from the
same records exactly as the application passes them (`settledFromRent` added), and the figures are compared.
Then the running application was walked screen by screen, on desktop and phone width, including every
print preview. Every defect found has a test that fails when the fix is removed.

## Defects found and fixed

| # | Where | What was wrong | Effect |
|---|-------|----------------|--------|
| 1 | Reports: Shortfall, ISPO Operations, Operations Statement | Fed the book-filtered, consolidated payments instead of the whole ledger | Shortfall read "maintenance paid J$0, funded by ISPO J$0" when the ledger said J$215,000 and J$150,000 |
| 2 | Dashboard, notifications | A let villa's levy was listed again on top of the rent that already contains it | A tenant owing 100,000 showed as 125,000; totals and health grade inflated |
| 3 | Charts, board pack, health grade | Arrears ageing had the same double count | Charts said J$700,000 while the dashboard said J$690,000 |
| 4 | Board pack | Receivable rows had the same double count | Headline J$690,000 beside a table row J$700,000 in the same document |
| 5 | Owner statements | Rent that ISPO collects was netted against ISPO's levy | "Due to ISPO J$50,000" on a villa whose tenant paid ISPO rent; ISPO's balance read J$37,000 owing when J$97,000 was |
| 6 | Notifications Hub | "Move-in date missing" offered "Post the undefined months" | A button that posted nothing |
| 7 | Shortfall and ISPO screens | Told users to "tick" a villa as let on the corporation's account (retired in 1.16.5) and said "VDS funded" for ISPO | Instructions that no longer worked; wrong party named |
| 8 | HOA & Tenants Ledger | No way to print the whole ledger | Added Print ledger, each currency totalled on its own |
| 9 | Annual report | Contributions were always twelve months of fees, and the default year was the previous one | A year before recording began (it began September 2026) printed a J$4,500,000 surplus against no expenditure. Now only recorded months count, years before the start are not offered, and the default is the current year while recording is in its first year |

## Held against each other and found in agreement (55 checks, `ecosystem-wiring`)

Money received (ledger, dashboard, owner statements, monthly report, annual return, projection, operating and
operations statements, ISPO operations, shortfall); money owed (ledger, Form 13B, monthly report, projection,
owner statements, dashboard, charts, board pack); costs (every expense figure); the two books partition every
receipt and every cost; USD never enters a JMD figure; one 25,000 payment moves every screen by exactly 25,000
and voiding it moves each back exactly.

## Observations for a decision (not changed)

- **Reservations report:** a stay is listed if its departure day equals the first day of the range, and "Nights
  sold" counts the whole stay, not only the nights inside the range. The screen says stays that overlap are
  included, so this is as designed, but the label overstates nights for a stay that straddles the range.
- **Operating statement, "everything" view:** account balances at period end are shown per book. This was not
  re-derived in this audit.

## Not covered

The Windows executable itself (CI smoke-tests it on Windows). Real figures on the HP: only seed data was used.
