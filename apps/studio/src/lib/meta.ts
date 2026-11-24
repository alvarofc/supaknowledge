/** <title> for a route's head(): "Inbox · Supaknowledge Studio". */
export function title(page?: string) {
  return { title: page ? `${page} · Supaknowledge Studio` : "Supaknowledge Studio" };
}
