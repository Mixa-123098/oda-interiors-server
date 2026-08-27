# oda-interiors-server

Node.js/Express + PostgreSQL backend for [oda-interiors.com](https://oda-interiors.com)
— a production website for an interior design and architecture studio.

Built and maintained solo since 2023.
Frontend: [oda-interiors-client](https://github.com/Mixa-123098/oda-interiors-client)

## Features

- REST API serving site content and the project portfolio
- Admin endpoints backing the content management interface
- Automated multilingual content (see below)

## Translation pipeline

Content is translated once, at save time — not on every request:

1. An editor saves content in the admin interface
2. The server calls the Anthropic (Claude) API for the translated versions
3. Results are stored in PostgreSQL alongside the source text
4. The public site is served entirely from the database

No LLM call sits in the request path. Page loads stay fast, API cost is bounded
by editing frequency rather than by traffic, and the text a visitor sees is
stable instead of being regenerated on every visit.

## Stack

Node.js · Express · PostgreSQL · Anthropic API

## Running locally

```bash
npm install
npm start
```
