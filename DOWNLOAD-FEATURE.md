# AI Response Download Feature

This feature allows users to download AI responses in multiple formats (Excel, CSV, Word, Text) when the AI provides structured data or tables.

## Features

### Automatic Table Detection
- Detects markdown tables in AI responses
- Identifies structured data patterns (lists, key-value pairs)
- Automatically shows download options when tabular data is found

### Supported Formats
- **CSV**: For tabular data, compatible with Excel and Google Sheets
- **Excel (.xlsx)**: Full-featured spreadsheet with auto-sized columns
- **Word (.docx)**: Complete document with text and tables
- **PowerPoint (.pptx)**: Presentation slides with content and data tables
- **Text (.txt)**: Plain text version of the response

### Mathematical Content Support
- **LaTeX Conversion**: Automatically converts LaTeX math expressions to readable text
- **Formula Recognition**: Detects mathematical formulas and derivatives
- **Symbol Translation**: Converts Greek letters and mathematical symbols
- **Structured Math**: Organizes mathematical examples into tables for easy download

### How It Works

1. **User asks for data**: "Create a table of top 10 countries by population"
2. **AI responds with structured data**: The AI provides data in table format
3. **Download buttons appear**: Automatically detected and shown in the message
4. **User downloads**: Click the download button and select format

### Example Prompts That Generate Downloadable Data

#### General Data Tables
```
- "Create a table of the top 10 countries by population with their capitals and GDP"
- "List the Fortune 500 top 20 companies with their revenue and employees"
- "Generate a comparison table of programming languages with features and use cases"
- "Create a monthly budget template with categories and amounts"
- "Show me the largest cities in Europe with population and area"
```

#### Mathematical Content
```
- "Show me examples of derivatives with formulas and explanations"
- "Create a table of trigonometric identities with their formulas"
- "List integration techniques with examples and solutions"
- "Generate a periodic table with element symbols and atomic masses"
- "Show calculus rules with mathematical expressions"
```

### Technical Implementation

#### Frontend (Client-side)
- **Detection**: Uses regex patterns to identify tables and structured data
- **Generation**: Creates files using `xlsx` and `docx` libraries
- **Download**: Uses browser APIs for file downloads

#### Backend (Server-side)
- **API Endpoints**: `/api/download/excel`, `/api/download/csv`, `/api/download/text`, `/api/download/powerpoint`
- **Math Processing**: Server-side LaTeX to text conversion
- **Fallback**: Server-side generation if client-side fails
- **Security**: Authenticated endpoints with user validation

### File Structure

```
lib/
├── download-utils.ts          # Core download utilities
components/
├── download-buttons.tsx       # Download UI component
├── download-demo.tsx         # Demo component
backend/src/routes/
├── download.js               # Backend download endpoints
```

### Usage in Components

```tsx
import { DownloadButtons } from '@/components/download-buttons';

// In your message component
<DownloadButtons 
  content={message.content} 
  messageId={message.id} 
/>
```

### API Usage

```typescript
// Download Excel file
const blob = await apiClient.downloadExcel(messageId, 'data.xlsx');
downloadFile(blob, 'data.xlsx');

// Download CSV file
const blob = await apiClient.downloadCSV(messageId, 'data.csv');
downloadFile(blob, 'data.csv');
```

### Dependencies

```json
{
  "xlsx": "^0.18.5",
  "docx": "^8.2.2",
  "pptxgenjs": "^3.12.0"
}
```

### Configuration

No additional configuration required. The feature works automatically when:
1. AI responses contain structured data
2. User is authenticated
3. Message exists in the database

### Error Handling

- **No table data**: Shows appropriate message
- **Backend failure**: Falls back to client-side generation
- **Network issues**: Provides user-friendly error messages
- **File generation errors**: Logs errors and shows toast notifications

### Performance

- **Client-side first**: Faster generation, no server load
- **Lazy loading**: Download utilities loaded only when needed
- **Efficient detection**: Fast regex-based table detection
- **Auto-sizing**: Excel columns automatically sized for readability

### Security

- **Authentication required**: All download endpoints require valid JWT
- **User validation**: Users can only download their own messages
- **Input sanitization**: All user inputs are properly sanitized
- **Rate limiting**: Protected by existing API rate limits

### Browser Compatibility

- **Modern browsers**: Chrome 60+, Firefox 55+, Safari 12+
- **File APIs**: Uses standard browser download APIs
- **Fallbacks**: Graceful degradation for older browsers