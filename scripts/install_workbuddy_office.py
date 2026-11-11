"""Provision verified local Office components; does not download or publish assets."""
import argparse
import importlib.util
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True,help='Validated office_runtime_assets from the migration source')
    parser.add_argument('--python-source',type=Path,required=True,help='Standalone Python 3.12.13 base runtime')
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'workbuddy-office-runtime/5.9.3')
    args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('office_asset_installer',Path(__file__).resolve().parents[1]/'plugins/uniwork-kits/office/assets.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    print(module.install(args.source,args.python_source,args.output))


if __name__=='__main__':main()
