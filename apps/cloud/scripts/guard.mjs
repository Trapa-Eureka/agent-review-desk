// Runs before `next dev` / `next start`: the team workspace server is unreleased and blocked (see middleware.ts).
if (process.env.ARD_UNRELEASED_CLOUD !== "1") {
  console.error("The team workspace server is not available yet. Paid plans are still in planning.");
  process.exit(1);
}
