# Runbook

What to do when something has to be put back, rolled back or replaced. The
deployment itself lives in `mortennordbye/Homelab` (`k8s/talos/apps/verksted/`,
promoted by Kargo per `k8s/talos/infra/kargo-projects/verksted.yaml`); what
follows is the verksted half of each job.

## Restore from a backup

Everything the bench knows is under `/data`, and `vk backup` exports all of it
(see README, "Backups"). Archives land in `VK_BACKUP_DIR`, which in the pod is
an NFS mount off the NAS.

1. **Find the archive.** `vk backups` lists them, newest first, with each one's
   manifest: when, from which host and image, how many repos were dirty.
2. **Have the passphrase** if the file ends in `.enc`: `VK_BACKUP_PASSPHRASE`
   must be set to the one it was written with. The restore reads the manifest
   first, so a wrong passphrase stops it before anything is written.
3. **Stop the app** if restoring onto the live volume. `vk restore` refuses the
   live `/data` while it is in use unless given `--force`, because the backend
   holds `settings.json` open and tmux holds sessions whose metadata would be
   replaced under them. In the cluster: scale the Deployment to 0, run the
   restore from a debug pod that mounts the PVC, scale back to 1.
4. `vk restore <archive>`. It checks the `.sha256` beside the archive, reads the
   manifest, extracts over the target (merging: files the archive lacks stay),
   and puts the modes of `settings.json`, `push.json`, the claude credentials
   and `~/.ssh` back to what the app writes.

**A drill, without touching anything live:** `vk restore <archive> --target
/tmp/restore-drill` from a session terminal, then look at what came back (the
repos, `settings.json`, `home/.claude`). No drill has been recorded yet; see
BACKLOG, "The restore has never been rehearsed".

## Roll back to an earlier image

verksted is a single `prod` Stage in Kargo, auto-promoted: each image CI pushes
becomes Freight, and promoting it opens a Homelab PR that you merge. To go back,
promote an earlier Freight to `prod` (the Kargo UI, or
`kargo promote --project verksted --stage prod --freight <name>`) and merge the
PR it opens.

Before either direction, know that the Deployment is `Recreate`: a new image
ends every tmux session on the pod. Take `vk backup` first if anything is
mid-flight, and expect claude sessions to come back through `--resume` and the
others to start fresh.

## Which build the pod is serving, and whether it is ready

`GET /api/health` answers `{ ok, build }`. `build` is the hashed name of the
frontend's entry script, the same name the page itself loads, so after a merge
it says whether the new image is the one answering without a look inside the
pod.

`GET /api/ready` answers 200 with `{ ready, tmux, volume }`, or 503 when tmux
cannot be reached or a file cannot be made in the sessions directory. `health`
stays the liveness probe: it answers whenever the process does. `ready` is what
a readiness probe should ask, and the Deployment in Homelab does not yet.

## Rotate a token

Agent credentials live in `SETTINGS_FILE` on the volume and are set on
**Settings → Agents**; the backend never reads them itself.

1. Make the new token where it comes from: `claude setup-token` on a machine
   with a browser (about a year), a new GitHub PAT, a new OpenAI or Antigravity
   key.
2. Paste it over the old value on Settings → Agents. It is stored at once.
3. **Sessions already running keep the old value**: a credential reaches an
   agent through the environment its tmux session was started with. End and
   restart any session that needs the new one.
4. Revoke the old token where it was issued. A token that ever sat in a
   commit, a log or an unencrypted backup is compromised; rotate it rather than
   deleting the line.

Google Calendar and Gmail share one OAuth sign-in on Settings → Sources:
"disconnect" revokes it at Google, and signing in again makes a new one.

## When the pod will not come up

`kubectl -n verksted logs deploy/verksted -c verksted` first. The backend
fails fast on bad configuration and says which variable, as `env: NAME ...`.
A backend that starts but is
not answering shows up in the connection banner as "can't reach the pod".
