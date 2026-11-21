# The daily note that replaced my morning metrics crawl

Every morning I used to open the same four places.

My blog analytics. My mailing list. Google Search Console. And the numbers for a book I wrote — Amazon and Goodreads.

I'd check what changed since yesterday, close the tabs, and go make coffee. Three or four minutes, every day, in the same order. It wasn't a big deal, but it was the first thing I did, and it was the same thing every time.

I didn't build a daily report for a long time because most of the ones I saw felt forced. Someone would wire up an agent to send a daily email with a fun personality, or summarize the email inbox they already had. If you need an email to tell you which emails you have, the email isn't the problem. I didn't want another surface to check. I wanted one page that had the four things I was already checking.

So I set up a daily note in Obsidian. One note, written before I wake up, that I read in about a minute.

## What's in it

The note has six sections, always in the same order:

- **Book** — orders, royalties, KENP pages, the last payment; Goodreads rating and review count; Amazon rating and review count.
- **Blog, last 28 days** — active users, average session, events.
- **GA4, yesterday** — sessions, engaged sessions, average engagement, events, source split.
- **Search Console, yesterday** — clicks, impressions, CTR, average position against a baseline.
- **Newsletter** — subscriber count, the last join, joins today.
- **Bottom line** — one sentence. Usually "nothing needs action today."

That's it. Bullets, not paragraphs. No adjectives, no sentences restating the numbers, no "traffic is looking strong." If nothing changed, the note says so.

The rule I care about most: if a source fails, the section says "unavailable" and names the source. It never guesses a number. A missing number is information. A wrong number is worse than no note.

## How it gets filled

A cron job runs at 5 a.m. It pulls six sources and writes the note.

Two of them are easy. Buttondown has an API, so the subscriber count is one request. Goodreads and Amazon don't have a clean API for what I need, so the job fetches the pages with a normal browser user agent and reads the rating out of the markup.

The other two are the reason this works. KDP, GA4, and Search Console don't give an agent a simple API for this. So the job uses OpenCLI to drive a browser: open the page, wait for it to load, read the table. The details are boring — check that the browser bridge is connected, bind a session, open the URL in a background window, wait a few seconds, evaluate the page. Once that path exists, any site I can log into is a source.

I set the job early enough that the note is done before I start the day. That's the whole scheduling decision. It doesn't need to be real-time. It needs to be waiting for me.

## The morning it caught something

In November I moved my blog from `kenmazaika.com` and `engineering.kenmazaika.com` to `notesfromtheloop.com`. There were a lot of moving pieces, and one of them was Google Analytics.

One morning the GA4 section didn't look right. The numbers were lower than they should have been, and they didn't match what I knew about the previous day. The stream wasn't loading from the pixel after the move. I fixed the Analytics setup, and the next day's numbers were correct.

That's why I keep it. I would have caught it eventually, probably when I looked at a weekly number and wondered why the graph had a hole in it. The note caught it the next morning, because the only job of the note is to show me what changed.

[Screenshot: the 2026-11-11 morning report, with the numbers blurred.]

## Setting one up

If you already check a few things every morning, the setup is small.

Tell your agent which sources matter, give it the section list, and give it the rules:

```text
Every morning at 5am, write tmp/daily-report/YYYY-MM-DD.md.

Sections, in this order:
Book, Blog (last 28 days), GA4 (yesterday), Search Console (yesterday),
Newsletter, Bottom line.

Bullets only. No adjectives. No restating numbers in prose.
If a source fails, write "unavailable" for that section and name it.
Never invent a number.
```

Then tell it how to fetch each source. Use an API where the site has one. For the rest, use browser automation: log in, open the page, read the table. If the agent can drive a browser, the source list is basically anything you can see when you're logged in.

Point the output at your Obsidian vault. The note can be a normal markdown file. Mine is the first thing I open on my phone.

It's a short report of what changed. I don't keep a running log in it, and I don't use it to plan the day. That's why it takes a minute, and why I still read it.
