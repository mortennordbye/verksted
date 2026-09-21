import { useState } from "react";
import type { SshKey } from "../../../../shared/api";
import { api, usePoll } from "../../api";
import { copyText } from "../../clipboard";
import { useConfirm } from "../../useConfirm";
import SectionLabel from "../SectionLabel";
import { SkeletonList } from "../Skeleton";
import Button from "../ui/Button";
import { Input, Textarea } from "../ui/Field";
import Notice from "../ui/Notice";
import { toast } from "../ui/Toast";

/**
 * Copy with feedback. The old button called navigator.clipboard directly, which
 * is undefined on a plain-HTTP origin — the deployment this app is written for
 * — so it silently did nothing and you found out when the paste came up empty.
 */
function CopyButton({ text }: { text: string }) {
  return (
    <Button
      onClick={async () =>
        toast((await copyText(text)) ? "public key copied" : "could not copy — select it instead")
      }
      title="copy public key"
    >
      copy
    </Button>
  );
}

export default function SshKeys() {
  const { data: keys, refresh } = usePoll<SshKey[]>("/api/ssh-keys", 30_000);
  const [name, setName] = useState("id_ed25519");
  const [material, setMaterial] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const key = await api<SshKey>("/api/ssh-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), privateKey: material }),
      });
      setMaterial("");
      setShown(key.name);
    });

  const generate = () =>
    run(async () => {
      const key = await api<SshKey>("/api/ssh-keys/generate", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setShown(key.name);
    });

  const [confirm, confirmDialog] = useConfirm();

  const remove = async (key: SshKey) => {
    const ok = await confirm({
      title: `Delete SSH key ${key.name}?`,
      body: "Anything authenticating with it — git pushes, remote hosts — stops working.",
      action: "delete the key",
      danger: true,
    });
    if (ok) void run(() => api(`/api/ssh-keys/${key.name}`, { method: "DELETE" }));
  };

  return (
    <>
      <SectionLabel icon="key" className="mt-10">
        SSH keys · ~/.ssh on the data volume
      </SectionLabel>
      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}
      <div className="flex flex-col gap-2">
        {(keys ?? []).map((k) => (
          <div
            key={k.name}
            className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-[12.5px]">{k.name}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-faint">
                {k.fingerprint}
              </span>
              <span className="ml-auto flex gap-2">
                <Button onClick={() => setShown(shown === k.name ? null : k.name)}>
                  {shown === k.name ? "hide" : "public key"}
                </Button>
                <Button onClick={() => remove(k)} disabled={busy} variant="ghost-danger">
                  delete
                </Button>
              </span>
            </div>
            {shown === k.name && (
              <div className="mt-2 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-[7px] border border-line bg-surface-2 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted">
                  {k.publicKey}
                </pre>
                <CopyButton text={k.publicKey} />
              </div>
            )}
          </div>
        ))}
        {keys === null && (
          <SkeletonList
            count={1}
            className="h-[54px] rounded-[11px] border border-line bg-surface"
          />
        )}
        {keys?.length === 0 && <div className="text-[13px] text-faint">no keys installed</div>}

        <div className="flex flex-col gap-2 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="key name"

              label="ssh key name"
              mono
              className="w-[200px]"
            />
            <Button
              onClick={generate}
              disabled={busy || !name.trim()}
              title="generate an ed25519 keypair in the pod — the private key never leaves it"
              aria-label="generate an ed25519 keypair in the pod — the private key never leaves it"
              variant="primary"
            >
              generate in pod
            </Button>
            <span className="text-[12px] text-faint">or paste a private key:</span>
          </div>
          <Textarea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"

            rows={3}
            spellCheck={false}
            label="private key"
            mono
            className="w-full"
          />
          {material.trim() && (
            <Button
              onClick={add}
              disabled={busy || !name.trim()}
              variant="primary"
              className="self-start"
            >
              add key
            </Button>
          )}
        </div>
      </div>
      <div className="mt-5 text-[13px] text-muted">
        Keys are write-only: only the public half is ever shown. Sessions pick them up automatically
        (git over ssh, plain ssh). Paste the public key into GitHub → Settings → SSH keys to push
        over ssh.
      </div>
      {confirmDialog}
    </>
  );
}
