# Cartoonr Backend v2

Adds server-side background Strip jobs.

- `POST /jobs` submits the entire Strip once.
- `GET /jobs/:id` returns live progress and completed images.
- `POST /jobs/:id/retry` retries one failed option.

Once `/jobs` returns a job ID, generation continues in the Railway process even if the browser tab closes.

Important prototype limitation: job state is held in Railway process memory. Closing the website is safe, but a Railway restart/redeploy can clear active/history jobs. The production persistence step should move jobs/results to a database/object store.


## Locked bubble style
Cartoonr now sends a built-in JSON-derived hand-drawn speech-bubble and lettering specification with every generation. No font or bubble upload is required.
