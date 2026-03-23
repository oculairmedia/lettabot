---
name: resume
description: Resume and CV management for generating, updating, and tailoring professional documents.
---

# Resume Management

Resume and CV management — generate, update, and tailor resumes for job applications. Provides tools for creating and customizing professional documents for career advancement and job applications.

## When to Use

- Generating a new resume from scratch
- Updating existing resume with new experience or skills
- Tailoring resume for specific job applications
- Converting resume to different formats (PDF, DOCX, etc.)
- Optimizing resume for applicant tracking systems (ATS)
- Creating multiple resume versions for different industries
- Extracting resume data for job applications
- Generating cover letters based on resume content

## Tools

### generate_resume
Generate a new resume from provided information.

**Parameters:**
- `name` (required) — Full name
- `email` (required) — Email address
- `phone` (optional) — Phone number
- `experience` (required) — Array of work experience entries
- `education` (required) — Array of education entries
- `skills` (optional) — Array of skills
- `summary` (optional) — Professional summary
- `format` (optional) — Output format (pdf, docx, markdown, html)

**Example:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "555-1234",
  "experience": [
    {
      "title": "Senior Developer",
      "company": "Tech Corp",
      "start_date": "2020-01",
      "end_date": "present",
      "description": "Led development of microservices"
    }
  ],
  "education": [
    {
      "degree": "BS Computer Science",
      "school": "State University",
      "year": 2018
    }
  ],
  "skills": ["Python", "JavaScript", "AWS"],
  "format": "pdf"
}
```

### update_resume
Update an existing resume with new information.

**Parameters:**
- `resume_id` (required) — ID of the resume to update
- `section` (required) — Section to update (experience, education, skills, summary, contact)
- `content` (required) — New content for the section
- `action` (optional) — Action to perform (add, replace, remove)

**Example:**
```json
{
  "resume_id": "resume-123",
  "section": "experience",
  "content": {
    "title": "Principal Engineer",
    "company": "Tech Corp",
    "start_date": "2023-01",
    "end_date": "present"
  },
  "action": "add"
}
```

### tailor_resume
Tailor resume for a specific job application.

**Parameters:**
- `resume_id` (required) — ID of the base resume
- `job_description` (required) — Job description to tailor for
- `company_name` (optional) — Name of the company
- `position_title` (optional) — Job title
- `focus_areas` (optional) — Areas to emphasize

**Example:**
```json
{
  "resume_id": "resume-123",
  "job_description": "We seek a Python developer with AWS experience...",
  "company_name": "CloudTech Inc",
  "position_title": "Senior Backend Engineer",
  "focus_areas": ["Python", "AWS", "Microservices"]
}
```

### convert_format
Convert resume to a different format.

**Parameters:**
- `resume_id` (required) — ID of the resume to convert
- `target_format` (required) — Target format (pdf, docx, markdown, html, txt)
- `template` (optional) — Resume template to use

**Example:**
```json
{
  "resume_id": "resume-123",
  "target_format": "pdf",
  "template": "modern"
}
```

### optimize_for_ats
Optimize resume for applicant tracking systems.

**Parameters:**
- `resume_id` (required) — ID of the resume to optimize
- `industry` (optional) — Industry for optimization
- `keywords` (optional) — Keywords to include

**Example:**
```json
{
  "resume_id": "resume-123",
  "industry": "technology",
  "keywords": ["Python", "AWS", "Docker", "Kubernetes"]
}
```

### extract_data
Extract structured data from a resume.

**Parameters:**
- `resume_id` (required) — ID of the resume
- `fields` (optional) — Specific fields to extract (name, email, experience, education, skills)

**Example:**
```json
{
  "resume_id": "resume-123",
  "fields": ["name", "email", "skills", "experience"]
}
```

### generate_cover_letter
Generate a cover letter based on resume and job description.

**Parameters:**
- `resume_id` (required) — ID of the resume
- `job_description` (required) — Job description
- `company_name` (required) — Company name
- `position_title` (required) — Job title
- `tone` (optional) — Tone of the letter (professional, friendly, formal)

**Example:**
```json
{
  "resume_id": "resume-123",
  "job_description": "We seek a Python developer...",
  "company_name": "CloudTech Inc",
  "position_title": "Senior Backend Engineer",
  "tone": "professional"
}
```

### list_resumes
List all available resumes.

**Parameters:**
- `filter` (optional) — Filter by name or status
- `limit` (optional) — Maximum number of resumes to return
- `offset` (optional) — Number of resumes to skip

**Example:**
```json
{
  "filter": "active",
  "limit": 10
}
```

### delete_resume
Delete a resume.

**Parameters:**
- `resume_id` (required) — ID of the resume to delete

**Example:**
```json
{
  "resume_id": "resume-123"
}
```

## When NOT to Use

- For creating resumes without any work experience or education data
- When you need to apply for jobs that don't accept resume submissions
- For modifying resumes that are currently being reviewed by employers
- When you need to create fictional or misleading resume content
- For tasks that require legal or compliance review of resume content
- When the resume needs to be submitted in a proprietary format not supported
