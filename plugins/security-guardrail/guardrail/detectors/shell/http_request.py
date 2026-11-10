"""Structured HTTP request extraction for shell ASK detectors."""

from __future__ import annotations

HTTP_STATE_CHANGING_METHODS = frozenset({"DELETE", "PATCH", "POST", "PUT"})

_CURL_DATA_OPTIONS = frozenset(
    {
        "--data",
        "--data-ascii",
        "--data-binary",
        "--data-raw",
        "--data-urlencode",
        "--form",
        "--form-string",
        "--json",
    }
)
_POWERSHELL_HTTP_COMMANDS = frozenset({"invoke-restmethod", "invoke-webrequest", "irm", "iwr"})
_SHORT_OPTION_PREFIX_LENGTH = 2
_CURL_VALUE_OPTIONS = frozenset(
    {
        "--data",
        "--data-ascii",
        "--data-binary",
        "--data-raw",
        "--data-urlencode",
        "--form",
        "--form-string",
        "--header",
        "--json",
        "--output",
        "--proxy",
        "--request",
        "--upload-file",
        "--user",
        "-d",
        "-F",
        "-H",
        "-o",
        "-T",
        "-u",
        "-x",
        "-X",
    }
)
_POWERSHELL_VALUE_OPTIONS = frozenset(
    {
        "-body",
        "-contenttype",
        "-headers",
        "-infile",
        "-method",
        "-outfile",
        "-proxy",
        "-uri",
        "-url",
    }
)


def extract_http_requests(command: str, args: tuple[str, ...]) -> tuple[tuple[str, str], ...]:
    """Return normalized ``(method, URL)`` pairs for recognized HTTP clients."""
    if command == "curl":
        method = _curl_method(args)
        urls = _curl_urls(args)
    elif command in _POWERSHELL_HTTP_COMMANDS:
        method = _powershell_method(args)
        urls = _powershell_urls(args)
    else:
        return ()
    if not method:
        return ()
    return tuple((method, url) for url in urls)


def _curl_method(args: tuple[str, ...]) -> str:
    explicit = ""
    has_get = False
    has_data = False
    index = 0
    while index < len(args):
        arg = args[index]
        option, separator, value = arg.partition("=")
        if option == "-X" or option.casefold() == "--request":
            explicit = value if separator else (args[index + 1] if index + 1 < len(args) else "")
            index += 1 if separator else 2
            continue
        if arg.startswith("-X") and not arg.startswith("--") and len(arg) > _SHORT_OPTION_PREFIX_LENGTH:
            explicit = arg[_SHORT_OPTION_PREFIX_LENGTH:]
        elif arg == "-G" or option.casefold() == "--get":
            has_get = True
        elif option.casefold() in _CURL_DATA_OPTIONS or arg == "-d" or arg.startswith(("-d", "-F")):
            has_data = True
        index += 1
    if explicit:
        return explicit.upper()
    if has_get:
        return "GET"
    return "POST" if has_data else "GET"


def _curl_urls(args: tuple[str, ...]) -> tuple[str, ...]:
    urls: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        option, separator, value = arg.partition("=")
        if option.casefold() == "--url":
            candidate = value if separator else (args[index + 1] if index + 1 < len(args) else "")
            _append_http_url(urls, candidate)
            index += 1 if separator else 2
            continue
        if option in _CURL_VALUE_OPTIONS or option.casefold() in _CURL_VALUE_OPTIONS:
            inline_short_option = not arg.startswith("--") and len(arg) > _SHORT_OPTION_PREFIX_LENGTH
            index += 1 if separator or inline_short_option else 2
            continue
        _append_http_url(urls, arg)
        index += 1
    return tuple(dict.fromkeys(urls))


def _powershell_method(args: tuple[str, ...]) -> str:
    value = _powershell_option_value(args, "-method")
    return value.upper() if value else "GET"


def _powershell_urls(args: tuple[str, ...]) -> tuple[str, ...]:
    urls: list[str] = []
    for option in ("-uri", "-url"):
        _append_http_url(urls, _powershell_option_value(args, option))
    if urls:
        return tuple(dict.fromkeys(urls))
    index = 0
    while index < len(args):
        arg = args[index]
        option, inline = _powershell_option(arg)
        if option in _POWERSHELL_VALUE_OPTIONS:
            index += 1 if inline else 2
            continue
        if not arg.startswith("-"):
            _append_http_url(urls, arg)
            if urls:
                break
        index += 1
    return tuple(dict.fromkeys(urls))


def _powershell_option_value(args: tuple[str, ...], expected: str) -> str:
    for index, arg in enumerate(args):
        option, inline = _powershell_option(arg)
        if option != expected:
            continue
        if inline:
            return inline
        return args[index + 1] if index + 1 < len(args) else ""
    return ""


def _powershell_option(arg: str) -> tuple[str, str]:
    for separator in (":", "="):
        if separator in arg:
            option, _, value = arg.partition(separator)
            return option.casefold(), value
    return arg.casefold(), ""


def _append_http_url(urls: list[str], candidate: str) -> None:
    value = candidate.strip().strip("\"'`").rstrip(",;)")
    if value.casefold().startswith(("http://", "https://")):
        urls.append(value)
