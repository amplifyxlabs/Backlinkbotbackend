const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const OpenAI = require('openai');

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: true, // Allow all origins in development
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Access-Control-Allow-Origin'],
  exposedHeaders: ['Access-Control-Allow-Origin'],
  credentials: true
}));

// Enable pre-flight requests for all routes
app.options('*', cors());

app.use(express.json());

// Helper function to extract text content from HTML
const extractTextContent = (html) => {
  const $ = cheerio.load(html);
  
  // Remove script and style elements
  $('script, style, iframe, noscript').remove();
  
  // Get the page title
  const title = $('title').text().trim();
  
  // Get meta description
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  
  // Get main content (prioritize main content areas)
  const mainContent = $('main, article, .content, #content, .main').text().trim();
  
  // Get headings
  const headings = [];
  $('h1, h2, h3').each((i, el) => {
    const text = $(el).text().trim();
    if (text) headings.push(text);
  });
  
  // Get paragraphs
  const paragraphs = [];
  $('p').each((i, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });
  
  // Get links
  const links = [];
  $('a').each((i, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && text && !href.startsWith('#')) {
      links.push({ href, text });
    }
  });
  
  return {
    title,
    metaDescription,
    mainContent: mainContent || $('body').text().trim(),
    headings,
    paragraphs,
    links
  };
};

// Endpoint to scrape a website
app.post('/api/scrape-website', async (req, res) => {
  const { websiteUrl, websiteName } = req.body;
  
  if (!websiteUrl) {
    return res.status(400).json({ 
      error: 'Website URL is required',
      details: 'Please provide a valid website URL'
    });
  }
  
  try {
    // Normalize URL
    let url = websiteUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log('Attempting to scrape:', url); // Add logging
    
    // Fetch the website content
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    console.log('Successfully fetched website'); // Add logging
    
    // Extract content
    const content = extractTextContent(response.data);
    
    console.log('Content extracted, analyzing with GPT...'); // Add logging
    
    // Use GPT-4o to analyze the content
    const gptAnalysis = await analyzeWebsiteWithGPT(content, websiteName);
    
    console.log('GPT analysis complete'); // Add logging
    
    // Return the scraped content and GPT analysis
    res.json({ 
      content,
      gptAnalysis,
      message: 'Website successfully analyzed'
    });
  } catch (error) {
    console.error('Error details:', error); // Add detailed error logging
    res.status(500).json({ 
      error: 'Failed to scrape website',
      message: error.message,
      details: error.response?.data || 'No additional details available'
    });
  }
});

// Function to analyze website content with GPT-4o
async function analyzeWebsiteWithGPT(content, websiteName) {
  try {
    // Create a more comprehensive content summary
    const contentSummary = `
      Website Name: ${websiteName}
      Title: ${content.title}
      Description: ${content.metaDescription}
      Main Headings: ${content.headings.slice(0, 5).join(', ')}
      Content Sample: ${content.paragraphs.slice(0, 3).join(' ')}
      Key Links: ${content.links.slice(0, 5).map(l => l.text).join(', ')}
    `;
    
    const prompt = `
      You are an expert website directory analyst with deep knowledge of online directories, SEO, and digital marketing.
      
      Analyze this website content and provide a detailed submission strategy.
      Focus on real, high-authority directory websites that would provide maximum value.
      
      Website Content to Analyze:
      ${contentSummary}
      
      Provide a comprehensive analysis with:
      1. Detailed Description (2-3 sentences explaining the website's purpose, value proposition, and unique features)
      2. Primary Categories (3-5 most relevant categories for directory listings)
      3. Key Features (3-5 standout features or benefits)
      4. Target Audience (Be specific about who would benefit most from this website)
      5. Directory Recommendations (Choose 5-7 most relevant from this list, ordered by relevance):
         - Product Hunt (for new tech products and tools)
         - G2 (for business software and services)
         - Capterra (for business software)
         - AlternativeTo (for software alternatives)
         - SaaSworthy (for SaaS products)
         - GetApp (for business applications)
         - TrustRadius (for B2B software)
         - SoftwareAdvice (for business software solutions)
         - SourceForge (for open-source and software)
         - Slant (for product comparisons)
         - Crozdesk (for business software)
         - Stackshare (for tech stack tools)
         - SaaSHub (for SaaS products)
         - AppSumo (for digital products and tools)
         - BetaList (for startup products)
      
      For each directory, include:
      - Why it's a good fit
      - Expected audience reach
      - Domain authority impact
      
      Format your response as JSON with this structure:
      {
        "description": "Detailed description here",
        "categories": ["Category 1", "Category 2", ...],
        "features": ["Feature 1", "Feature 2", ...],
        "targetAudience": "Detailed target audience description",
        "suggestedDirectories": [
          {
            "name": "Directory Name",
            "url": "https://directory-url.com",
            "relevance": "High/Medium/Low",
            "reason": "Why this directory is relevant",
            "audienceReach": "Large/Medium/Small",
            "domainAuthority": "High/Medium/Low"
          }
        ],
        "marketingTips": ["Tip 1", "Tip 2", ...],
        "keywordSuggestions": ["Keyword 1", "Keyword 2", ...]
      }
    `;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "You are a website directory expert specializing in maximizing online visibility through strategic directory submissions. Provide detailed, actionable insights based on website analysis."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });
    
    const analysis = JSON.parse(response.choices[0].message.content);
    
    // Save the complete analysis to the database format
    return {
      description: analysis.description,
      categories: analysis.categories,
      features: analysis.features,
      targetAudience: analysis.targetAudience,
      suggestedDirectories: analysis.suggestedDirectories,
      marketingTips: analysis.marketingTips,
      keywordSuggestions: analysis.keywordSuggestions,
      analysisDate: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error analyzing with GPT:', error);
    return null;
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 