"""Python clients through the egress proxy: requests (when available) and urllib.
Usage: client_python.py <default-lease-proxy-url> <deny-lease-proxy-url>"""
import sys
import urllib.request

DEFAULT, DENY = sys.argv[1], sys.argv[2]
ALLOWED = "https://git.example.test:8443/x"
RUNTIME = "https://model.example.test:8443/x"


def report(name, expected, actual):
    print(f"{'PASS' if expected == actual else 'FAIL'} {name} (expected {expected!r}, got {actual!r})")


def urllib_status(proxy, url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
    try:
        with opener.open(url, timeout=20) as response:
            return response.status
    except OSError as error:
        return f"error:{type(error).__name__}"


report("python urllib: default lease", 200, urllib_status(DEFAULT, ALLOWED))
report("python urllib: deny lease is refused", True, str(urllib_status(DENY, ALLOWED)).startswith("error:"))

try:
    import requests
except ImportError:
    print("FAIL python requests: not importable (run.sh mounts the host's copy)")
else:
    def requests_status(proxy, url):
        try:
            return requests.get(url, proxies={"https": proxy, "http": proxy}, timeout=20).status_code
        except requests.exceptions.ProxyError as error:
            return "proxy_error:403" if "403" in str(error) else f"proxy_error:{error}"

    report("python requests: default lease", 200, requests_status(DEFAULT, ALLOWED))
    report("python requests: deny lease is refused", "proxy_error:403", requests_status(DENY, ALLOWED))
    report("python requests: deny lease reaches the runtime host", 200, requests_status(DENY, RUNTIME))
