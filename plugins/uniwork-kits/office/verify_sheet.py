"""PM worker: formula repair and recalculation run outside the Hermes environment."""
from pathlib import Path
import json
import sys
from office_cli import verify_native_xlsx

if __name__=='__main__':
    print(json.dumps(verify_native_xlsx(Path(sys.argv[1]),Path(sys.argv[2]),90,
        preserve_formula_source=Path(sys.argv[3]) if len(sys.argv)>3 else None,
        preserve_numeric_values='--numeric-values' in sys.argv[4:]),ensure_ascii=False))
