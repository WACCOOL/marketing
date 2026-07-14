import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Flex,
  Heading,
  Input,
  Link,
  LoadingSpinner,
  Select,
  Tag,
  Text,
  TextArea,
  hubspot,
} from "@hubspot/ui-extensions";

/**
 * Quote Desk — CRM card on Deal records.
 *
 * One front door for every quote request type (standard / revision / follow-up
 * change / custom / Schonbek / international). Replaces the prefilled HubSpot
 * form + make.com scenario: the card reads deal properties directly, blocks
 * submit until the required fields are complete, and the Worker
 * (marketing.gowac.cc) files the Zendesk ticket, mirrors it to a HubSpot
 * ticket, and writes corrected values back onto the deal.
 *
 * The field contract is FETCHED from /api/quote-desk/spec (single source of
 * truth in @wac/shared) — don't hardcode required-field lists here.
 *
 * Requests go through hubspot.fetch: HubSpot signs them (v3) and appends the
 * calling user's identity server-side, which is what the Worker trusts.
 */

const BASE = "https://marketing.gowac.cc/api/quote-desk";
const SUBMIT_TIMEOUT_MS = 45_000;

// Deal properties the card prefills from (superset of the write-back fields).
const PREFILL_PROPS = [
  "dealname",
  "account_number",
  "sap_quote_number",
  "quote_needed_by",
  "project_location",
  "estimated_onsite_date",
  "discount_request",
  "air_freight_pricing",
  "do_you_need_submittal_layout_support",
  "how_can_we_help",
  "hs_priority",
];

const STATUS_VARIANT = {
  new: "warning",
  open: "warning",
  pending: "default",
  hold: "default",
  solved: "success",
  closed: "default",
};

function randomId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `qd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function api(path, init) {
  const res = await hubspot.fetch(`${BASE}${path}`, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, data };
}

hubspot.extend(({ context, actions }) => <QuoteDesk context={context} actions={actions} />);

function QuoteDesk({ context, actions }) {
  const dealId = String(context.crm.objectId);

  const [spec, setSpec] = useState(null); // {fields, types}
  const [tickets, setTickets] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [recipientContactId, setRecipientContactId] = useState("");
  const [loadError, setLoadError] = useState(null);

  const [requestType, setRequestType] = useState("new");
  const [values, setValues] = useState({});
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // {kind:"success"|"error", ...}
  const [requestId, setRequestId] = useState(randomId);

  const refreshTickets = useCallback(async () => {
    const res = await api(`/tickets?dealId=${dealId}`);
    if (res.ok) setTickets(res.data.tickets ?? []);
    else setTickets([]);
  }, [dealId]);

  useEffect(() => {
    (async () => {
      const [specRes, props] = await Promise.all([
        api("/spec"),
        actions.fetchCrmObjectProperties(PREFILL_PROPS).catch(() => ({})),
      ]);
      if (!specRes.ok) {
        setLoadError(
          `Quote Desk backend unavailable (${specRes.status}). ` +
            (specRes.data && specRes.data.error ? specRes.data.error : ""),
        );
        return;
      }
      setSpec(specRes.data);
      const prefill = {};
      for (const name of PREFILL_PROPS) {
        if (props[name] !== null && props[name] !== undefined && props[name] !== "") {
          prefill[name] = String(props[name]);
        }
      }
      prefill.subject = prefill.subject || props.dealname || "";
      setValues(prefill);
      refreshTickets();
      api(`/contacts?dealId=${dealId}`).then((res) => {
        if (res.ok) setContacts(res.data.contacts ?? []);
      });
    })();
  }, [actions, refreshTickets]);

  const typeSpec = spec ? spec.types[requestType] : null;
  const missing = useMemo(() => {
    if (!typeSpec) return [];
    return typeSpec.required.filter((name) => !String(values[name] ?? "").trim());
  }, [typeSpec, values]);

  const setField = (name) => (value) => {
    setValues((v) => ({ ...v, [name]: value }));
  };

  const submit = async () => {
    setTouched(true);
    if (missing.length) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api("/requests", {
        method: "POST",
        timeout: SUBMIT_TIMEOUT_MS,
        body: JSON.stringify({
          requestId,
          dealId,
          requestType,
          requesterName: [context.user.firstName, context.user.lastName]
            .filter(Boolean)
            .join(" "),
          recipientContactId: recipientContactId || undefined,
          recipientName:
            (contacts.find((c) => c.id === recipientContactId) || {}).name || undefined,
          fields: values,
        }),
      });
      if (res.ok) {
        setResult({ kind: "success", ...res.data });
        setRequestId(randomId()); // next submission is a new request
        setTouched(false);
        refreshTickets();
      } else if (res.status === 422 && res.data && res.data.missing) {
        setResult({
          kind: "error",
          message: `Missing required fields: ${res.data.missing.join(", ")}`,
        });
      } else {
        setResult({
          kind: "error",
          message:
            (res.data && res.data.error) || `Request failed (${res.status}). Please try again.`,
        });
      }
    } catch (e) {
      setResult({ kind: "error", message: `Request failed: ${e.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) return <Alert title="Quote Desk" variant="error">{loadError}</Alert>;
  if (!spec) return <LoadingSpinner label="Loading Quote Desk…" />;

  const typeOptions = Object.entries(spec.types).map(([value, t]) => ({
    value,
    label: t.label,
  }));

  const renderField = (name, required) => {
    const field = spec.fields[name];
    if (!field) return null;
    const label = required ? `${field.label} *` : field.label;
    const isMissing = touched && required && !String(values[name] ?? "").trim();
    const common = {
      key: name,
      name,
      label,
      error: isMissing,
      validationMessage: isMissing ? "Required" : undefined,
    };
    if (field.kind === "textarea") {
      return (
        <TextArea {...common} value={values[name] ?? ""} onChange={setField(name)} rows={4} />
      );
    }
    if (field.kind === "checkbox") {
      return (
        <Checkbox
          key={name}
          name={name}
          checked={values[name] === "Yes"}
          onChange={(checked) => setField(name)(checked ? "Yes" : "")}
        >
          {field.label}
        </Checkbox>
      );
    }
    if (field.kind === "select" && field.options && field.options.length) {
      return (
        <Select
          {...common}
          options={field.options.map((o) => ({ value: o, label: o }))}
          value={values[name] ?? ""}
          onChange={setField(name)}
        />
      );
    }
    // date fields use a plain input (YYYY-MM-DD) — matches the deal property format
    return (
      <Input
        {...common}
        value={values[name] ?? ""}
        placeholder={field.kind === "date" ? "YYYY-MM-DD" : undefined}
        onChange={setField(name)}
      />
    );
  };

  return (
    <Flex direction="column" gap="md">
      <Heading>Quote tickets</Heading>
      {tickets === null ? (
        <LoadingSpinner label="Loading tickets…" />
      ) : tickets.length === 0 ? (
        <Text variant="microcopy">No quote tickets yet for this deal.</Text>
      ) : (
        <Flex direction="column" gap="sm">
          {tickets.map((t) => (
            <Flex key={t.zendeskTicketId} direction="row" gap="sm" align="center" wrap="wrap">
              <Tag variant={STATUS_VARIANT[t.status] || "default"}>{t.status || "unknown"}</Tag>
              <Link href={t.zendeskUrl}>#{t.zendeskTicketId}</Link>
              <Text>{t.subject || t.requestType || ""}</Text>
              {t.quoteNumber ? <Text variant="microcopy">Quote {t.quoteNumber}</Text> : null}
            </Flex>
          ))}
        </Flex>
      )}

      <Divider />
      <Heading>New request</Heading>
      <Select
        label="Request type"
        name="requestType"
        options={typeOptions}
        value={requestType}
        onChange={(v) => {
          setRequestType(v);
          setTouched(false);
          setResult(null);
        }}
      />
      {typeSpec.required.map((name) => renderField(name, true))}
      {typeSpec.optional.map((name) => renderField(name, false))}
      {contacts.length ? (
        <Select
          label="Send quote to (optional)"
          name="recipientContactId"
          options={[
            { value: "", label: "—" },
            ...contacts.map((c) => ({
              value: c.id,
              label: c.email ? `${c.name} (${c.email})` : c.name,
            })),
          ]}
          value={recipientContactId}
          onChange={setRecipientContactId}
        />
      ) : null}

      {result && result.kind === "error" ? (
        <Alert title="Not submitted" variant="error">{result.message}</Alert>
      ) : null}
      {result && result.kind === "success" ? (
        <Alert title={resultTitle(result)} variant="success">
          <Link href={result.zendeskUrl}>Zendesk ticket #{result.zendeskTicketId}</Link>
        </Alert>
      ) : null}

      <Flex direction="row" gap="sm" align="center">
        <Button variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? "Submitting…" : "Submit request"}
        </Button>
        {touched && missing.length ? (
          <Text variant="microcopy">
            {missing.length} required field{missing.length > 1 ? "s" : ""} left
          </Text>
        ) : null}
      </Flex>
    </Flex>
  );
}

function resultTitle(result) {
  if (result.action === "comment") return "Added to the open quote ticket";
  if (result.action === "followup") return "Follow-up ticket created (previous ticket was closed)";
  if (result.action === "duplicate") return "Already submitted";
  return "Quote request submitted";
}
