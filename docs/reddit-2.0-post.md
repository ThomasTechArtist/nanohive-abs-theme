# NanoHive ABS Theme 2.0

*Draft for r/audiobookshelf and r/selfhosted.*

---

**Title:** NanoHive ABS Theme 2.0 — a themed reverse proxy for Audiobookshelf Web (no Tampermonkey, applies to every user)

---

NanoHive is a small nginx container you put in front of your Audiobookshelf server. It injects a theme into the HTML on the way out. Nothing is written to your ABS container, nothing is installed per browser, and every user gets it — including guests. Pull the proxy out and you're back to stock ABS.

Web only. The mobile apps keep working through it, they just aren't themed.

2.0 is a big one. What's in it:

**Ratings**

- Server-wide star ratings with short reviews, shared by everyone on the server
- Stars on every card while browsing; series show the average of the books inside
- A "Rate what you finished" row on the home page for books you finished but never rated
- Admins can remove anyone's rating

**Sorting and filtering (rebuilt)**

- **Multi-level sort**: pick author, then series, then title — up to 8 dimensions, each ascending or descending, with the precedence numbered as you pick
- **Stackable filters**: genre, author, narrator, language, decade, progress and rating, combined (any value within a dimension, all dimensions together), each value showing its count
- Both live inside ABS's own Filter and Sort menus, and a chip shows how many are active

**Stats**

- **Server Ranking**: everyone ranked by listening time, medals for the top three, week/month/year/all-time, click a person for their breakdown
- **Server statistics** (admin): what the whole server listens to — most played, best rated, top genres, top authors, filterable per library
- **Your listening**: current and longest streak, this week against last, the weekday you actually listen on, your most-listened books, authors and narrators
- **Year in Review**
- The ranking includes people who never open the web app: an admin's browser publishes a small summary per user. On by default; switching sharing off removes you from the board and its totals and deletes your shared data

**Three things people keep asking upstream for**

- **Autoplay the next book in a series** when one ends, with a notice naming what started (off by default — it decides what your speakers do)
- **Finished-book tools**: fix the finished date (ABS stamps when you ticked the box, not when you finished), and a list of books stuck at 97-99% — every book with credits or silence at the end — with one tap to mark them done
- **Report a problem** in any book's three-dot menu (missing content, bad audio, won't play, wrong metadata). Admins get a live count on their account button and a queue to clear

**Browsing**

- **Search every library at once** — one merged result list with a library badge per hit
- **Collections** rebuilt: an icon emblem per collection instead of a wall of covers, so they load instantly, plus starter templates with pre-written descriptions and in-app editing
- **Narrators and Authors** are proper card pages with cover collages, counts, filtering and sorting, instead of a bare table
- **Custom series covers and descriptions**, uploaded from the app — with a generated cover (layered deck, grid, or first book) when there is none
- Pick your own **start page**

**Look**

- 12 base themes and any accent colour, per user
- Hero carousel of your in-progress books on the home page
- Redesigned book page: big cover, blurred cinematic background
- Reorderable home sections
- User profile photos, shown in the top bar and the ranking
- Upload your own logo, hosted by the proxy, so it still loads on an air-gapped server
- Extended ereader with a typeface picker including OpenDyslexic
- Book lookup links on the book page — Goodreads plus the biggest site for your language, 25 logos bundled
- Translated into all 40 languages ABS ships

**Admin**

- Save the current look as the **server default**, selectively per area
- Force-disable individual features for everyone
- **Tidy authors**: remove authors left behind with no books

**Mobile**

A lot of this release went into it: the home hero is cover-first and fits the first screen whole, grids are centred and fit more per row, the series page scrolls as one page, and the charts and year heatmap fit instead of overflowing.

**Running it**

Docker, in front of ABS. One volume at `/data/nh` if you want ratings, stats and uploads to survive a container recreate. Compose example and env vars are in the repo.

Repo: https://github.com/rodzalendo/nanohive-abs-theme

Happy to hear what's missing — most of 2.0 came from things people asked for in 1.x.
