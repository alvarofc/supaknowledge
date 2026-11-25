# supaknowledge (Python)

Python client for [Supaknowledge](https://github.com/alvarofc/supaknowledge), an open-source knowledge factory
built on Supabase. Search, read and flag company knowledge, load skills, record agent traces for the curator,
and hand Supaknowledge to any tool-calling model as OpenAI-compatible (or plain JSON Schema) tools.
Depends only on `httpx`. Python 3.10+.

> Status: alpha (0.x). APIs may change between minor versions.

```bash
pip install supaknowledge
```

```python
import os
from supaknowledge import Supaknowledge

kf = Supaknowledge(url="https://<project>.supabase.co", space="acme/finance", api_key=os.environ["SUPAKNOWLEDGE_API_KEY"])
for r in kf.search("weekly revenue"):
    print(r["path"], r.get("trust"))

kf.flag("incorrect", "revenue_usd does not exist; found revenue_usd_net",
        concept_path="data/orders", suggested_fix="use revenue_usd_net")
```

Full guide (traces, tool loops, MCP client config):
[docs/sdk.md](https://github.com/alvarofc/supaknowledge/blob/main/docs/sdk.md#python).

## License

[Apache-2.0](https://github.com/alvarofc/supaknowledge/blob/main/LICENSE). Supaknowledge is a community project
and is not affiliated with or endorsed by Supabase, Inc.
