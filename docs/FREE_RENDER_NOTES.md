# Free Render deployment notes

This variant uses Render's `plan: free` and removes the persistent disk.

That should make the Blueprint preview show $0/month, but it is only suitable for smoke testing:

- The BDP/CIE session is stored under `/data`, but `/data` is ephemeral without a disk.
- The stored session can disappear after redeploys, restarts, and free-service spin-downs.
- Free compute has limited CPU/RAM, so cloud Chromium may be slow or may fail under memory pressure.
- For a stable prototype, switch back to a paid service with a persistent disk.

To return to the paid prototype, change `plan: free` to `plan: standard` and add the disk block back:

```yaml
    disk:
      name: bdp-session-data
      mountPath: /data
      sizeGB: 1
```
