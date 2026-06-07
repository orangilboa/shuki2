// Backend API request/response types. These are defined once in
// openshuki-shared (so the frontend's typed client can't drift from them) and
// re-exported here so existing backend imports of "../types/index.js" keep
// resolving. Add backend-only types below the re-export if ever needed.

export * from "openshuki-shared";
