# Engage: Public Participation & Reporting inside the existing Forum area

Copy these four files over the same paths in the NIT project and restart. Tables are created automatically on startup (idempotent, additive).

| File | Change |
|---|---|
| `routes/community-reports.js` | NEW. Report, support and consultation routes, plus `ensureCommunityReportsTables()` (creates tables, seeds 3 demo reports REP-2026-001249..1251 and 2 demo consultations only when empty). |
| `server.js` | 2 lines: require and `app.use` the new router. |
| `bootstrap/startup.js` | 1 line: run `ensureCommunityReportsTables()` after the RBAC bootstrap. |
| `public/index.html` | Engage toolbar (Forum / Consultations / Report an Issue / Community Reports) inside the Forum pane; existing Forum markup wrapped in `#egForum`, unchanged; new CSS and script before `</body>`; the earlier iframe "Participate & Report" tab is removed and Forum is the default again. |

Forum backend: NOT modified (`routes/forum.js`, `lib/forum.js`, forum tables and `/api/forum` untouched). The only forum-side additions are client-side: a "Report this issue" button appended to rendered posts, and "Discuss in Forum" pre-filling the existing compose box.

New tables: community_reports, community_report_photos, community_report_supports (UNIQUE report_id+user_id), community_report_events, consultations, consultation_views, consultation_rsvps.

API: GET/POST /api/community-reports, GET /api/community-reports/:ref, POST /api/community-reports/:id/support (toggle, one per user), PATCH /api/community-reports/:id/status (WARD_ADMIN+ and ward-scoped), GET /api/admin/community-reports (WARD_ADMIN+), GET /api/consultations, POST /api/consultations/:id/views and /rsvp.

Photos are saved to `public/uploads/reports/` (JPG/PNG/WEBP, max 4, 5 MB each, magic-byte checked).
