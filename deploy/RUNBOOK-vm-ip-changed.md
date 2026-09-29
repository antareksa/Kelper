# Runbook: Dashboard / Packing Station unreachable after a VM stop/start

## Symptom
- `https://dashboard.kelper.co.id` and/or `https://packing.kelper.co.id` time out
  (`ERR_CONNECTION_TIMED_OUT`), even though SSH to the VM still works fine.
- `kelper-production`'s Console page shows status **Running**.
- On the VM itself, `sudo systemctl status kelper` shows the backend healthy,
  and Caddy is listening on 80/443 (`sudo ss -tlnp | grep -E ':443|:80'`).

If SSH works but HTTPS doesn't, the VM and app are fine — this is a DNS
pointing-at-the-wrong-IP problem, not an app/server problem.

## Root cause
The VM's external IP was **ephemeral**, not a reserved static IP. Stopping
the VM (e.g. to edit its service account, machine type, etc.) releases the
ephemeral IP back to Google's pool; starting it again assigns a **new**
random external IP. DNS still points at the old one until manually updated.

## Diagnosis
1. Compare the VM's actual current external IP (Console → Compute Engine →
   VM instances → `kelper-production` → External IP column) against what DNS
   currently resolves to:
   ```bash
   nslookup dashboard.kelper.co.id
   nslookup packing.kelper.co.id
   ```
   If they don't match the Console's External IP, that's the bug.

## Fix
1. **Update DNS** — cPanel → **Zone Editor** → `kelper.co.id` → edit the **A
   record** for each affected subdomain (`dashboard`, `packing`) to the new
   IP. Check both; they're separate records and it's easy to only remember
   one.
2. **Promote the new IP to static** so this never happens again — Console →
   **VPC network → IP addresses** → find the VM's current ephemeral IP →
   **⋮ → Promote to static IP address**.
3. **Wait for DNS propagation** — check progress at
   [dnschecker.org](https://dnschecker.org) (A record, the subdomain).
   Usually minutes, bounded by the record's TTL.

## If it's still broken after DNS propagates everywhere (per dnschecker)
This almost always means **your own machine's configured DNS resolver**
(router or ISP, not Windows' own cache) is still serving a stale cached
answer independent of global propagation. `ipconfig /flushdns` only clears
Windows' *own* cache — it can't force your router/ISP's resolver to refresh
early. Symptom: a normal Chrome window may work (Chrome's Secure DNS/DoH
queries a different, already-updated resolver) while a **fresh Chrome
profile** (e.g. the Packing Station kiosk profile) or anything using the OS
resolver directly (`Test-NetConnection`, curl without `--resolve`) still
times out.

Confirm with PowerShell (uses the real OS resolver, not Chrome's DoH):
```powershell
Test-NetConnection -ComputerName packing.kelper.co.id -Port 443
```
If `RemoteAddress` shows the old IP, that confirms it.

**Immediate, guaranteed fix** — hardcode the correct IP in the Windows hosts
file on that machine (bypasses DNS entirely):
1. Press Windows key → type `Notepad` → **right-click → Run as
   administrator** (a normal launch can't save this file — it'll silently
   fail or prompt Access Denied on save).
2. File → Open → paste `C:\Windows\System32\drivers\etc\hosts` → if the file
   doesn't show up, change the file-type filter to **"All Files (*.*)"**
   (the hosts file has no extension).
3. Add a line per affected hostname at the end of the file:
   ```
   <new-ip> packing.kelper.co.id
   <new-ip> dashboard.kelper.co.id
   ```
4. Ctrl+S. If it silently doesn't save (no error, but the file still reads
   old content on reopen), Notepad wasn't actually elevated — close it and
   redo step 1, making sure to right-click, not just open normally.
5. Verify: `Test-NetConnection -ComputerName packing.kelper.co.id -Port 443`
   should now show `TcpTestSucceeded : True` against the new IP.

This entry stays correct permanently once step 2 of the main fix (promote to
static IP) is done — the IP won't drift again.
