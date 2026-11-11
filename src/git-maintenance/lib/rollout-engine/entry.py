#!/usr/bin/env python3
"""Trusted airules renderer closure: fetched repositories contribute data only."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import composition
import render

def trusted_composition(source, profile):
    return composition.resolve_composition(composition.load_catalog(source, "1c"), "dsh-deepseek", profile, "1c", "common")

render.load_composition = trusted_composition
# The host pins the verified source commit in the candidate manifest.
# Do not consult ambient Git filters, hooks or machine configuration here.
render.git_state = lambda source: {"revision": "", "dirty": False}
raise SystemExit(render.main())
