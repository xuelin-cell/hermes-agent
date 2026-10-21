import type { ProviderActionDefinition } from "../../core/provider-definition.ts";
import type { JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "aminer";

const text = (description: string): JsonSchema => s.nonEmptyString(description);
const integer = (description: string): JsonSchema => s.integer(description);
const textArray = (description: string): JsonSchema => s.array(description, s.nonEmptyString("One value."));
const result = (description: string): JsonSchema => s.unknown(description);

function input(
  description: string,
  properties: Record<string, JsonSchema>,
  optional: readonly string[] = [],
): JsonSchema {
  return s.looseRequiredObject(description, properties, { optional });
}

export const aminerActions: readonly ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "search_paper",
    description:
      "Search AMiner papers by title, keywords, abstract, author, organization, or venue and return matching paper IDs.",
    inputSchema: input(
      "Paper search filters. Supply at least one meaningful search field.",
      {
        title: text("Words from the paper title."),
        keyword: text("Keywords associated with the paper."),
        abstract: text("Words expected in the abstract."),
        author: text("An author name."),
        org: text("An author organization."),
        venue: text("A journal or conference name."),
        page: integer("The one-based result page."),
        size: integer("The number of results to return."),
        order: text("The AMiner result ordering option."),
      },
      ["title", "keyword", "abstract", "author", "org", "venue", "page", "size", "order"],
    ),
    outputSchema: result("Paper matches returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "search_paper_by_title",
    description: "Search AMiner for paper IDs, titles, and DOIs using a paper title.",
    inputSchema: input(
      "A title-based paper search.",
      {
        title: text("The paper title to search for."),
        page: s.integer("The one-based result page, up to 10.", { minimum: 1, maximum: 10 }),
        size: s.integer("The number of results to return, up to 20.", { minimum: 1, maximum: 20 }),
      },
      ["page", "size"],
    ),
    outputSchema: result("Paper title matches returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "search_person",
    description: "Search AMiner for scholar IDs, names, and affiliations.",
    inputSchema: input(
      "Scholar search filters.",
      {
        name: text("The scholar name to search for."),
        org: text("An organization name used to narrow the search."),
        org_id: text("An AMiner organization ID used to narrow the search."),
        size: integer("The number of scholars to return."),
      },
      ["org", "org_id", "size"],
    ),
    outputSchema: result("Scholar matches returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "search_patent",
    description: "Search AMiner for patent IDs, titles, and publication numbers by patent name.",
    inputSchema: input(
      "A patent search.",
      {
        query: text("The patent name or search phrase."),
        page: s.integer("The one-based result page, up to 5.", { minimum: 1, maximum: 5 }),
        size: s.integer("The number of results to return, up to 20.", { minimum: 1, maximum: 20 }),
      },
      ["page", "size"],
    ),
    outputSchema: result("Patent matches returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "search_organization",
    description: "Search AMiner for organization IDs and canonical names using one or more name queries.",
    inputSchema: input("Organization names to search for.", {
      orgs: textArray("Organization names or name fragments."),
    }),
    outputSchema: result("Organization matches returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "search_venue",
    description: "Search AMiner for journal or conference IDs and standard names.",
    inputSchema: input("A journal or conference search.", {
      name: text("The journal or conference name."),
    }),
    outputSchema: result("Venue matches returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_paper_detail",
    description: "Get detailed AMiner metadata for one paper, including authors, DOI, keywords, venue, and year.",
    inputSchema: input("A paper lookup.", { id: text("The AMiner paper ID.") }),
    outputSchema: result("Detailed paper metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_papers_info",
    description: "Get summary metadata for up to 100 AMiner papers in one call.",
    inputSchema: input("A batch paper lookup.", {
      ids: s.array("AMiner paper IDs, up to 100.", text("One AMiner paper ID."), { maxItems: 100 }),
    }),
    outputSchema: result("Batch paper metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_person_detail",
    description: "Get a scholar profile from AMiner, including biography, education, position, and honors.",
    inputSchema: input("A scholar lookup.", { id: text("The AMiner scholar ID.") }),
    outputSchema: result("Detailed scholar metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_person_figure",
    description: "Get an AMiner scholar portrait with research interests, domains, work history, and education.",
    inputSchema: input("A scholar portrait lookup.", { id: text("The AMiner scholar ID.") }),
    outputSchema: result("The scholar portrait returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_person_stats",
    description: "Get AMiner statistics for a scholar, including publication, citation, H-index, and G-index values.",
    inputSchema: input("A scholar statistics lookup.", { id: text("The AMiner scholar ID.") }),
    outputSchema: result("Scholar statistics returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_person_projects",
    description: "Get projects led by or involving an AMiner scholar.",
    inputSchema: input("A scholar project lookup.", { id: text("The AMiner scholar ID.") }),
    outputSchema: result("Scholar projects returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_patent_detail",
    description: "Get detailed AMiner patent metadata, including claims, applicants, assignees, and inventors.",
    inputSchema: input("A patent lookup.", { id: text("The AMiner patent ID.") }),
    outputSchema: result("Detailed patent metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_patent_info",
    description: "Get concise AMiner patent metadata, including title, publication number, country, and inventors.",
    inputSchema: input("A patent summary lookup.", { id: text("The AMiner patent ID.") }),
    outputSchema: result("Patent summary metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_organization_detail",
    description: "Get AMiner details for one or more organizations, including names, aliases, type, and profile data.",
    inputSchema: input("An organization lookup.", {
      ids: textArray("AMiner organization IDs."),
    }),
    outputSchema: result("Organization metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_venue_detail",
    description: "Get AMiner details for a journal or conference, including ISSN, aliases, and venue type.",
    inputSchema: input("A venue lookup.", { id: text("The AMiner venue ID.") }),
    outputSchema: result("Venue metadata returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_person_papers",
    description: "List papers associated with an AMiner scholar.",
    inputSchema: input("A scholar paper lookup.", { id: text("The AMiner scholar ID.") }),
    outputSchema: result("Papers associated with the scholar."),
  }),
  defineProviderAction(service, {
    name: "get_person_patents",
    description: "List patents associated with an AMiner scholar.",
    inputSchema: input("A scholar patent lookup.", { id: text("The AMiner scholar ID.") }),
    outputSchema: result("Patents associated with the scholar."),
  }),
  defineProviderAction(service, {
    name: "get_paper_citations",
    description: "List papers cited by an AMiner paper.",
    inputSchema: input("A paper citation lookup.", { id: text("The AMiner paper ID.") }),
    outputSchema: result("Cited papers returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_organization_papers",
    description: "List papers published by scholars from an AMiner organization.",
    inputSchema: input(
      "An organization paper lookup.",
      {
        org_id: text("The AMiner organization ID."),
        offset: s.nonNegativeInteger("The result offset."),
      },
      ["offset"],
    ),
    outputSchema: result("Organization papers returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_organization_persons",
    description: "List scholars associated with an AMiner organization.",
    inputSchema: input(
      "An organization scholar lookup.",
      {
        org_id: text("The AMiner organization ID."),
        offset: s.nonNegativeInteger("The result offset."),
      },
      ["offset"],
    ),
    outputSchema: result("Organization scholars returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_organization_patents",
    description: "List patents assigned to or applied for by an AMiner organization.",
    inputSchema: input(
      "An organization patent lookup.",
      {
        id: text("The AMiner organization ID."),
        page: s.positiveInteger("The one-based result page."),
        page_size: s.positiveInteger("The number of patents to return."),
        source: s.stringEnum("The organization role to match.", ["ass", "app"]),
      },
      ["page", "page_size", "source"],
    ),
    outputSchema: result("Organization patents returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "get_venue_papers",
    description: "List papers published in an AMiner journal or conference, optionally filtered by year.",
    inputSchema: input(
      "A venue paper lookup.",
      {
        id: text("The AMiner venue ID."),
        offset: s.nonNegativeInteger("The result offset."),
        limit: s.positiveInteger("The maximum number of papers to return."),
        year: integer("The publication year to filter by."),
      },
      ["offset", "limit", "year"],
    ),
    outputSchema: result("Venue papers returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "disambiguate_organization",
    description: "Normalize a free-form organization name to an AMiner canonical organization name.",
    inputSchema: input("An organization name to normalize.", { org: text("The free-form organization name.") }),
    outputSchema: result("The canonical organization match returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "disambiguate_organization_pro",
    description: "Resolve a free-form organization name to AMiner first-level and second-level organization IDs.",
    inputSchema: input("An organization name to resolve.", { org: text("The free-form organization name.") }),
    outputSchema: result("The resolved organization hierarchy returned by AMiner."),
  }),
  defineProviderAction(service, {
    name: "recommend_paper",
    description: "Recommend AMiner papers using research topics, a scholar name, or an AMiner scholar ID.",
    inputSchema: {
      ...input(
        "Paper recommendation interests. Supply topics, author_name, or aminer_author_id.",
        {
          topics: textArray("Research topics of interest."),
          author_name: text("A scholar name used as a recommendation seed."),
          author_org: text("The scholar organization used to narrow an author-name match."),
          aminer_author_id: text("An AMiner scholar ID used as a recommendation seed."),
          size: s.integer("The number of recommendations, from 1 to 20.", { minimum: 1, maximum: 20 }),
        },
        ["topics", "author_name", "author_org", "aminer_author_id", "size"],
      ),
      anyOf: [{ required: ["topics"] }, { required: ["author_name"] }, { required: ["aminer_author_id"] }],
    },
    outputSchema: result("Paper recommendations returned by AMiner."),
  }),
];
