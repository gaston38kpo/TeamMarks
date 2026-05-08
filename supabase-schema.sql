-- TeamMarks — Supabase Database Schema
-- Run this SQL in the Supabase SQL Editor to set up all required tables,
-- indexes, and Row Level Security policies.

-- ============================================================
-- Organizations
-- ============================================================
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Teams
-- ============================================================
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    invite_code TEXT UNIQUE NOT NULL DEFAULT substr(md5(random()::text), 1, 6),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Team Members
-- ============================================================
CREATE TABLE team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, user_id)
);

-- ============================================================
-- Bookmarks
-- ============================================================
CREATE TABLE bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES bookmarks(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,                       -- NULL for folders
    is_folder BOOLEAN NOT NULL DEFAULT false,  -- distinguishes bookmark folders from bookmarks
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by UUID REFERENCES auth.users(id),
    last_modified_by UUID REFERENCES auth.users(id),  -- tracks who last modified (self-write detection)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ          -- soft delete
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_teams_organization_id ON teams(organization_id);
CREATE INDEX idx_team_members_user_id ON team_members(user_id);
CREATE INDEX idx_team_members_team_id ON team_members(team_id);
CREATE INDEX idx_bookmarks_team_id ON bookmarks(team_id);
CREATE INDEX idx_bookmarks_parent_id ON bookmarks(parent_id);
CREATE INDEX idx_bookmarks_updated_at ON bookmarks(updated_at);
CREATE INDEX idx_bookmarks_deleted_at ON bookmarks(deleted_at);
CREATE INDEX idx_bookmarks_team_updated ON bookmarks(team_id, updated_at);

-- ============================================================
-- Row Level Security
-- ============================================================

-- Helper function: check if user is admin of at least one team in an org
CREATE OR REPLACE FUNCTION is_org_admin(org_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1
        FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.user_id = auth.uid()
          AND tm.role = 'admin'
          AND t.organization_id = org_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: check if an org has any teams yet
CREATE OR REPLACE FUNCTION org_has_teams(org_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM teams WHERE organization_id = org_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: check if current user is a member of a team
-- Used by RLS policies to avoid infinite recursion on team_members self-reference
CREATE OR REPLACE FUNCTION is_team_member(tid UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM team_members
        WHERE team_id = tid AND user_id = auth.uid()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: check if current user is an admin of a team
CREATE OR REPLACE FUNCTION is_team_admin(tid UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM team_members
        WHERE team_id = tid AND user_id = auth.uid() AND role = 'admin'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Teams: members can read their own teams; any authenticated user can create
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_read_teams" ON teams
    FOR SELECT USING (is_team_member(id));

CREATE POLICY "authenticated_insert_teams" ON teams
    FOR INSERT WITH CHECK (
        auth.uid() IS NOT NULL
    );

-- NOTE: When inserting with .select() (RETURNING), PostgreSQL requires the
-- new row to also pass the SELECT policy. This creates a chicken-and-egg
-- problem: the creator isn't a member yet, so is_team_member() returns false.
-- Solution: insert without .select(), add membership, then fetch the team.

-- Team Members: users can read members of their own teams
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_memberships" ON team_members
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "users_read_teammates" ON team_members
    FOR SELECT USING (is_team_member(team_id));

CREATE POLICY "users_insert_own_membership" ON team_members
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "admins_delete_membership" ON team_members
    FOR DELETE USING (is_team_admin(team_id));

-- Bookmarks: full CRUD for team members only
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_read_bookmarks" ON bookmarks
    FOR SELECT USING (is_team_member(team_id));

CREATE POLICY "team_members_insert_bookmarks" ON bookmarks
    FOR INSERT WITH CHECK (is_team_member(team_id));

CREATE POLICY "team_members_update_bookmarks" ON bookmarks
    FOR UPDATE USING (is_team_member(team_id));

CREATE POLICY "team_members_delete_bookmarks" ON bookmarks
    FOR DELETE USING (is_team_member(team_id));

-- ============================================================
-- Database Function: updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_bookmarks_updated_at
    BEFORE UPDATE ON bookmarks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Seed Data: Default Organization
-- ============================================================
-- The default organization used by the MVP. The hardcoded placeholder
-- org ID '00000000-0000-0000-0000-000000000000' in team-management.js
-- references this row. You can change the name/slug to match your company.
INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000000', 'Default Organization', 'default-org')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Security Function: find_team_by_invite_code
-- ============================================================
-- Allows authenticated users to look up a team by invite code
-- without bypassing RLS on the teams table. Returns only the
-- minimum fields needed to complete the join flow — never
-- exposes the invite_code itself.
CREATE OR REPLACE FUNCTION find_team_by_invite_code(code TEXT)
RETURNS TABLE(id UUID, name TEXT, description TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT t.id, t.name, NULL::TEXT AS description
    FROM teams t
    WHERE t.invite_code = UPPER(TRIM(code));
END;
$$;

GRANT EXECUTE ON FUNCTION find_team_by_invite_code(TEXT) TO authenticated;