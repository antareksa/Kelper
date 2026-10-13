# SSH Quick Commands

The commands used most often, typed on the VM. Full details: `SSH-CHEATSHEET.md`.

## Deploy the latest code
```bash
cd /opt/kelper && git pull && bash deploy/setup-vm.sh
```
Then reload the Dashboard and Packing Station pages.

## Server
```bash
sudo systemctl status kelper --no-pager     # is it running?
sudo journalctl -u kelper -f --no-pager     # live logs (Ctrl+C to stop)
sudo systemctl restart kelper               # restart (needed after editing .env.production)
nano /opt/kelper/kelper-backend/.env.production   # edit settings, then restart
```

## Order fetching
```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/fetch-lock.js status     # check
NODE_ENV=production node scripts/fetch-lock.js lock       # stop new orders
NODE_ENV=production node scripts/fetch-lock.js unlock     # start again
NODE_ENV=production node scripts/fetch-lock.js unlock 5   # let 5 new orders in, then stop
```

## Backup
```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/backup.js save           # save a backup
NODE_ENV=production node scripts/backup.js list           # list backups
NODE_ENV=production node scripts/backup.js load latest    # restore (replaces the database, asks first)
```

## Admin logins
```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js list
NODE_ENV=production node scripts/manage-admin.js add <username> <password>           # full admin
NODE_ENV=production node scripts/manage-admin.js add <username> <password> packing   # Packing Station admin
NODE_ENV=production node scripts/manage-admin.js remove <username>
```

## Other
```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/release-exception.js <order_sn>   # release an order stuck in Masalah (booking failed)
NODE_ENV=production node scripts/check-ads.js                      # check Biaya Iklan
```
