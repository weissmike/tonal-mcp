"""End-to-end OAuth check against a deployed gateway.

  OWNER_TOKEN=... python scripts/oauth_flow_test.py https://tonal.example.com

Runs: discovery, dynamic client registration, login (wrong then right owner token), code exchange,
an MCP call with the OAuth token, refresh, and a junk-token rejection. Note: servers that need an MCP
session handshake (e.g. the Lose It origin) report 400 for the bare tools/call in step 1/10/12; auth itself passed.
"""
import base64, hashlib, http.cookiejar, json, pathlib, re, secrets, sys, urllib.error, urllib.parse, urllib.request

import os, sys
O = sys.argv[1].rstrip("/")
BEARER = os.environ["OWNER_TOKEN"]
UA = {"User-Agent": "tonal-oauth-test/1.0"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar))


def req(method, url, data=None, headers=None, form=False):
    h = dict(UA, **(headers or {}))
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode(); h["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode(); h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, body, h, method=method)
    try:
        resp = opener.open(r, timeout=60)
    except urllib.error.HTTPError as e:
        resp = e
    return resp.status if hasattr(resp, "status") else resp.code, dict(resp.headers), resp.read().decode()


def mcp(token, tool="get_user_stats"):
    s, h, b = req("POST", O + "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": {}}},
                  {"Authorization": "Bearer " + token, "Accept": "application/json, text/event-stream"})
    return s, b[:120].replace("\n", " ")


print("1 owner bearer ->", mcp(BEARER))
print("2 no token     ->", req("POST", O + "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {"Accept": "application/json, text/event-stream"})[:2])
s, h, b = req("GET", O + "/.well-known/oauth-protected-resource/mcp"); print("3 PRM", s, b[:200])
s, h, b = req("GET", O + "/.well-known/oauth-authorization-server"); meta = json.loads(b); print("4 AS meta", s, {k: meta.get(k) for k in ("issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "code_challenge_methods_supported")})

redirect = "https://claude.ai/api/mcp/auth_callback"
s, h, b = req("POST", meta["registration_endpoint"], {"client_name": "Claude (oauth test)", "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"],
                                                      "response_types": ["code"], "token_endpoint_auth_method": "none"})
print("5 DCR", s); client = json.loads(b); cid = client["client_id"]

verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
q = urllib.parse.urlencode({"response_type": "code", "client_id": cid, "redirect_uri": redirect, "scope": "mcp", "state": "xyz",
                            "code_challenge": challenge, "code_challenge_method": "S256", "resource": O + "/mcp"})
s, h, b = req("GET", meta["authorization_endpoint"] + "?" + q)
print("6 authorize GET", s, "| shows client:", "Claude (oauth test)" in b, "| redirect host shown:", "claude.ai" in b)
handle = re.search(r'name="handle" value="([^"]+)"', b).group(1)

s, h, b = req("POST", meta["authorization_endpoint"] + "?" + q, {"handle": handle, "token": "wrong-token", "decision": "approve"}, form=True)
print("7 wrong token ->", s)
s, h, b = req("GET", meta["authorization_endpoint"] + "?" + q); handle = re.search(r'name="handle" value="([^"]+)"', b).group(1)
s, h, b = req("POST", meta["authorization_endpoint"] + "?" + q, {"handle": handle, "token": BEARER, "decision": "approve"}, form=True)
loc = h.get("Location") or h.get("location") or ""
print("8 approve ->", s, loc[:70])
qs = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
assert qs.get("state") == ["xyz"] and "code" in qs, qs

s, h, b = req("POST", meta["token_endpoint"], {"grant_type": "authorization_code", "code": qs["code"][0], "redirect_uri": redirect, "client_id": cid,
                                                "code_verifier": verifier, "resource": O + "/mcp"}, form=True)
print("9 token", s, {k: (v if k in ("token_type", "expires_in", "scope") else "<hidden>") for k, v in json.loads(b).items()})
tok = json.loads(b)
print("10 /mcp with OAuth token ->", mcp(tok["access_token"]))
s, h, b = req("POST", meta["token_endpoint"], {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": cid}, form=True)
print("11 refresh", s)
print("12 /mcp with refreshed token ->", mcp(json.loads(b)["access_token"], "get_muscle_readiness"))
print("13 /mcp with junk token ->", mcp("junk")[0])
