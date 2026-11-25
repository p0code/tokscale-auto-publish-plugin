// Draft: lives in apps/web/src/components/settings/ once the host API lands (docs/HOST_API.md).
import type { EnvironmentId } from "@t3tools/contracts";
import {
  TOKSCALE_PLUGIN_ID,
  type TokscaleAction,
  TokscalePreview,
  TokscaleStatus,
} from "@t3tools/plugin-tokscale-auto-publish/actions";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const decodeStatus = Schema.decodeUnknownOption(TokscaleStatus);
const decodePreview = Schema.decodeUnknownOption(TokscalePreview);
const tokens = new Intl.NumberFormat(undefined, { notation: "compact" });
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

export function TokscaleDisclosure() {
  return (
    <div className="space-y-1 text-muted-foreground">
      <p>
        <T>
          Sends Tokscale, per day and model: the model's name, its input, output, cache and
          reasoning token counts, its cost and message count, and an anonymous device id.
        </T>
      </p>
      <p>
        <T>Never sent: prompts, replies, code, thread titles, project names or file paths.</T>
      </p>
    </div>
  );
}

export function TokscalePanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const plugins = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const message =
    plugins.data?.plugins.find((plugin) => plugin.manifest.id === TOKSCALE_PLUGIN_ID)?.message ??
    null;
  const [status, setStatus] = useState<TokscaleStatus | null>(null);
  const [preview, setPreview] = useState<TokscalePreview | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const call = async (action: TokscaleAction, input: unknown = {}) => {
    const result = await invoke({
      environmentId,
      input: { pluginId: TOKSCALE_PLUGIN_ID, action, input },
    });
    return result._tag === "Success" ? result.value : null;
  };
  const run = async (action: TokscaleAction, input: unknown = {}) => {
    setBusy(true);
    const decoded = decodeStatus(await call(action, input));
    if (Option.isSome(decoded)) setStatus(decoded.value);
    setBusy(false);
  };
  const loadPreview = async () => {
    setBusy(true);
    const decoded = decodePreview(await call("preview"));
    setPreview(Option.getOrNull(decoded));
    setBusy(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushes only a one-line status; the details come back from the plugin's status action.
  useEffect(() => {
    if (message === null) return;
    void invoke({
      environmentId,
      input: { pluginId: TOKSCALE_PLUGIN_ID, action: "status", input: {} },
    }).then((result) => {
      if (result._tag !== "Success") return;
      const decoded = decodeStatus(result.value);
      if (Option.isSome(decoded)) setStatus(decoded.value);
    });
  }, [environmentId, invoke, message]);

  if (status === null) return null;
  const pending = preview?.days.filter((day) => !day.published) ?? [];

  return (
    <div className="space-y-4">
      {status.error ? (
        <p role="alert" className="text-destructive">
          {status.error}
        </p>
      ) : message ? (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      ) : null}

      {status.pendingSignIn ? (
        <div className="flex flex-wrap items-center gap-3">
          <code className="text-lg tracking-widest">{status.pendingSignIn.userCode}</code>
          <Button
            render={
              <a href={status.pendingSignIn.verificationUrl} target="_blank" rel="noreferrer" />
            }
          >
            <T>Approve in browser</T>
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void run("signOut")}>
            <T>Cancel</T>
          </Button>
        </div>
      ) : status.signedIn ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto truncate">{status.account ?? gt("Signed in to Tokscale")}</span>
          <Button variant="ghost" disabled={busy} onClick={() => void run("signOut")}>
            <T>Sign out</T>
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => void run("signIn")}>
            <T>Sign in to Tokscale</T>
          </Button>
          <form
            className="flex flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run("setToken", { token }).then(() => setToken(""));
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              aria-label={gt("Tokscale API token")}
              placeholder="tt_…"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={busy || token.trim() === ""}>
              <T>Use token</T>
            </Button>
          </form>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void loadPreview()}>
          {preview === null ? <T>Preview what is sent</T> : <T>Refresh preview</T>}
        </Button>
        <Button
          disabled={busy || !status.signedIn || preview === null || pending.length === 0}
          onClick={() => void run("publishNow").then(loadPreview)}
        >
          <T>Publish now</T>
        </Button>
      </div>

      {preview ? (
        <div className="space-y-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{gt("Day")}</TableHead>
                <TableHead>{gt("Model")}</TableHead>
                <TableHead className="text-right">{gt("Input")}</TableHead>
                <TableHead className="text-right">{gt("Output")}</TableHead>
                <TableHead className="text-right">{gt("Cache")}</TableHead>
                <TableHead className="text-right">{gt("Cost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.days.toReversed().flatMap((day) =>
                day.models.map((model, index) => (
                  <TableRow
                    key={`${day.date}/${model.client}/${model.model}`}
                    className={day.published ? "text-muted-foreground" : undefined}
                  >
                    <TableCell>
                      {index === 0 ? (
                        <span className="flex items-center gap-2">
                          {day.date}
                          {day.published ? <Badge variant="outline">{gt("Sent")}</Badge> : null}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="truncate">{model.model}</TableCell>
                    <TableCell className="text-right">{tokens.format(model.input)}</TableCell>
                    <TableCell className="text-right">
                      {tokens.format(model.output + model.reasoning)}
                    </TableCell>
                    <TableCell className="text-right">
                      {tokens.format(model.cacheRead + model.cacheWrite)}
                    </TableCell>
                    <TableCell className="text-right">{usd.format(model.cost)}</TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
          {preview.skipped.length > 0 ? (
            <p className="text-muted-foreground">
              {gt("Not sent")}: {preview.skipped.map((skip) => skip.model).join(", ")}
            </p>
          ) : null}
          {preview.body ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                POST {preview.endpoint}
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                {preview.body}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <label className="flex items-center justify-between gap-3">
        <T>Publish automatically</T>
        <div className="flex items-center gap-2">
          <Select
            items={[
              { value: "daily", label: gt("Daily") },
              { value: "hourly", label: gt("Hourly") },
            ]}
            value={status.config.schedule}
            disabled={busy}
            onValueChange={(schedule) => {
              if (schedule !== null) void run("setConfig", { schedule });
            }}
          >
            <SelectTrigger size="sm" className="w-28" aria-label={gt("Schedule")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="daily">{gt("Daily")}</SelectItem>
              <SelectItem value="hourly">{gt("Hourly")}</SelectItem>
            </SelectPopup>
          </Select>
          <Switch
            checked={status.config.autoPublish}
            // Turning it on needs a sign-in and a look at exactly what will be sent.
            disabled={busy || !status.signedIn || (!status.config.autoPublish && preview === null)}
            onCheckedChange={(autoPublish) => void run("setConfig", { autoPublish })}
          />
        </div>
      </label>

      <details>
        <summary className="cursor-pointer text-muted-foreground">
          <T>Service</T>
        </summary>
        <ServiceForm status={status} busy={busy} onSave={(patch) => run("setConfig", patch)} />
      </details>
    </div>
  );
}

function ServiceForm(props: {
  readonly status: TokscaleStatus;
  readonly busy: boolean;
  readonly onSave: (patch: { apiUrl?: string; timeZone?: string | null }) => Promise<void>;
}) {
  const gt = useGT();
  const [apiUrl, setApiUrl] = useState(props.status.config.apiUrl);
  const [timeZone, setTimeZone] = useState(props.status.config.timeZone ?? "");
  return (
    <form
      className="mt-2 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({ apiUrl, timeZone: timeZone.trim() === "" ? null : timeZone.trim() });
      }}
    >
      <Input
        aria-label={gt("Tokscale URL")}
        value={apiUrl}
        onChange={(event) => setApiUrl(event.target.value)}
      />
      <Input
        aria-label={gt("Time zone")}
        placeholder={props.status.timeZone}
        value={timeZone}
        onChange={(event) => setTimeZone(event.target.value)}
      />
      <p className="text-muted-foreground text-xs">
        {gt("Device")} {props.status.deviceId}
      </p>
      <Button type="submit" variant="outline" disabled={props.busy}>
        <T>Save</T>
      </Button>
    </form>
  );
}
