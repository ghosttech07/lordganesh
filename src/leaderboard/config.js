// Leaderboard backend. The anon key is a *public* key by design — Supabase
// row-level security and the Edge Functions decide what it can do (read the
// leaderboard views, call claim-name / submit-score). Baking the defaults in
// means every build of the game — GitHub Pages, a friend's clone, a phone on
// the LAN — plays on the same global board. Override with VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY in a .env to point at a different project.
export const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://rdotizbqvvpugysmelnk.supabase.co';
export const SUPABASE_ANON_KEY =
  import.meta.env?.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkb3RpemJxdnZwdWd5c21lbG5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NzExODgsImV4cCI6MjEwNTE0NzE4OH0.LqmlOIEsm8geO_hx2TZRuU7rKP1iL4P2vB04xDSyCdY';
