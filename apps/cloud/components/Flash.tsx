type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The green/red message a redirected form leaves in the address (`?notice=` / `?error=`). Rendered as plain text. */
export default function Flash({ params }: { params: Params }) {
  const notice = first(params.notice);
  const error = first(params.error);
  return (
    <>
      {notice ? (
        <div className="flash notice" role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="flash error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}

export const param = first;
