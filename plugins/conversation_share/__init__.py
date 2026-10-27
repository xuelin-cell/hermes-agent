"""Cloud sharing reuses the desktop tool and provenance contract."""

def register(ctx):
    from hermes_cli.config import load_config
    if not load_config().get('cloud_sharing', {}).get('enabled'):
        return
    from importlib import import_module
    import_module('apps.desktop.assets.artifact-share-plugin').register(ctx)
