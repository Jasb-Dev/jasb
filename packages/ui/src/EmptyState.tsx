/**
 * The empty state — and the product's thesis.
 *
 * This is the only place the serif register appears at size. It states what the
 * product does and, deliberately, what it refuses to do: the "not" list is the
 * positioning, so it is content, not fine print.
 */
export function EmptyState({ onPick }: { onPick(example: string): void }) {
  return (
    <section className="empty">
      <h1 className="empty__headline">
        Type what you want.
        <br />
        Get the <em>right sites</em>.
      </h1>

      <p className="empty__sub">
        The results are websites, not an answer written for you. No chat panel, no agent
        clicking on your behalf, no sponsored cards. History and preferences stay on this
        device.
      </p>

      <ul className="empty__list">
        <Row
          keys="figma.com"
          description="A URL or a bare domain goes straight there — no search, no model, no delay."
          onPick={onPick}
        />
        <Row
          keys="!w tardigrade"
          description="Bangs jump to a site's own search. So does “wikipedia for tardigrade”."
          onPick={onPick}
        />
        <Row
          keys="cheap flights berlin to lisbon"
          description="Plain intent returns a small grid of sites, each labelled with what it is."
          onPick={onPick}
        />
        <Row
          keys="1 – 6"
          description="Open a result from the keyboard. ⌘L or / returns you to the bar."
        />
      </ul>
    </section>
  );
}

function Row({
  keys,
  description,
  onPick,
}: {
  keys: string;
  description: string;
  onPick?(example: string): void;
}) {
  const content = (
    <>
      <span className="empty__key">{keys}</span>
      <span className="empty__desc">{description}</span>
    </>
  );

  // Rows that name a real query are runnable; the shortcut row is not.
  return onPick ? (
    <li className="empty__item">
      <button
        type="button"
        className="empty__key"
        style={{ textAlign: "left", color: "var(--signal)" }}
        onClick={() => onPick(keys)}
      >
        {keys}
      </button>
      <span className="empty__desc">{description}</span>
    </li>
  ) : (
    <li className="empty__item">{content}</li>
  );
}
