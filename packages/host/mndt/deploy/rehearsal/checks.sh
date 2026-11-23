# Verdicts of the rehearsal scripts that decide on facts gathered elsewhere,
# kept apart so a test can make each of them fail (tests/rehearsalChecks.spec.ts).

# seed_restart_verdict <approvals before> <approvals after> <started before> <started after>
# The approvals descriptor and its rendered patch, fingerprinted before and after
# seed-team.sh, and the workbench's start time around it. Prints one OK/KO line;
# returns 1 on KO. Unchanged: no restart is the right answer. Changed: seed-team.sh
# must have restarted the workbench on its own.
seed_restart_verdict() {
  if [ "$1" = "$2" ]; then
    echo "OK  seed-restart   approvals descriptor and patch unchanged by seed-team.sh: no restart needed ($([ "$3" = "$4" ] && echo none || echo 'one anyway'))"
  elif [ "$3" != "$4" ]; then
    echo "OK  seed-restart   seed-team.sh restarted the workbench after rewriting approvals"
  else
    echo "KO  seed-restart   seed-team.sh rewrote approvals but did not restart the workbench"
    return 1
  fi
}
