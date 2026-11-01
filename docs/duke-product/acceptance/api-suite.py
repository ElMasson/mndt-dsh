#!/usr/bin/env python3
"""Read-only API acceptance suite for the mndt product.

Runs on the server, against the workbench API on 127.0.0.1:8795, with a person
header per identity. It answers three questions: what each identity sees, whether
a private mission stays private, and whether the agent mission is shared.

No write: only GET requests.
"""
import json
import urllib.request

API = 'http://127.0.0.1:8795'
IDENTITIES = ['duke@datanalysis.re', 'gouvernance@datanalysis.re', 'smarion@datanalysis.re']


def page(identity):
    request = urllib.request.Request(API + '/state', headers={'x-forwarded-email': identity})
    answer = json.load(urllib.request.urlopen(request, timeout=60))
    return answer.get('page', answer.get('state', answer))


report = {'identities': {}, 'checks': {}}
states = {}
for identity in IDENTITIES:
    state = page(identity)
    states[identity] = state
    report['identities'][identity] = {
        'role': state.get('role'),
        'canWrite': state.get('canWrite'),
        'canAdmin': state.get('canAdmin'),
        'missions': len(state.get('missions', [])),
        'briefs': len(state.get('briefs', [])),
        'approvals': len(state.get('approvals', [])),
        'mandates': len(state.get('mandates', []) or []),
    }

private = {}
team = {}
for identity, state in states.items():
    for mission in state.get('missions', []):
        if mission.get('visibility') == 'private':
            private.setdefault(identity, set()).add(mission['id'])
        if mission.get('visibility') == 'team':
            team.setdefault(mission['id'], set()).add(identity)

checks = {}
duke_private = private.get('duke@datanalysis.re', set())
smarion_private = private.get('smarion@datanalysis.re', set())
checks['duke_private_not_visible_to_smarion'] = all(
    mission_id not in {m['id'] for m in states['smarion@datanalysis.re'].get('missions', [])}
    for mission_id in duke_private
)
checks['smarion_private_not_visible_to_duke'] = all(
    mission_id not in {m['id'] for m in states['duke@datanalysis.re'].get('missions', [])}
    for mission_id in smarion_private
)
checks['agent_team_mission_visible_to_all'] = bool(team) and all(len(owners) == 3 for owners in team.values())
checks['private_counts'] = {identity: len(ids) for identity, ids in private.items()}
checks['team_mission_ids'] = sorted(team.keys())
report['checks'] = checks
print(json.dumps(report, indent=2))
