import json
from bs4 import BeautifulSoup
import os

def convert_html_to_json(input_filename, output_filename):
    # Check if file exists
    if not os.path.exists(input_filename):
        print(f"Error: The file '{input_filename}' was not found.")
        return

    print(f"Reading {input_filename}...")
    
    with open(input_filename, 'r', encoding='utf-8') as f:
        html_content = f.read()

    soup = BeautifulSoup(html_content, 'html.parser')
    
    # Locate the specific table by ID as seen in the source
    table = soup.find('table', id='tablepress-3')
    
    if not table:
        print("Error: Could not find the table with id 'tablepress-3'.")
        return

    aircraft_data = []
    
    # Iterate over the table body rows
    rows = table.find('tbody').find_all('tr')
    
    print(f"Found {len(rows)} aircraft entries. Processing...")

    for row in rows:
        cells = row.find_all('td')
        
        if len(cells) >= 6:
            # Extract text and strip whitespace
            category = cells[0].get_text(strip=True)
            manufacturer = cells[1].get_text(strip=True)
            model = cells[2].get_text(strip=True)
            livery = cells[3].get_text(strip=True)
            registration = cells[4].get_text(strip=True)
            
            # Extract image URL
            # We prioritize the anchor 'href' (full size) over the img 'src' (thumbnail)
            image_url = None
            link_tag = cells[5].find('a')
            img_tag = cells[5].find('img')
            
            if link_tag and 'href' in link_tag.attrs:
                image_url = link_tag['href']
            elif img_tag and 'src' in img_tag.attrs:
                image_url = img_tag['src']
            
            # Build the dictionary entry
            entry = {
                "category": category,
                "manufacturer": manufacturer,
                "model": model,
                "livery": livery,
                "registration": registration,
                "image": image_url
            }
            
            aircraft_data.append(entry)

    # Write to JSON file
    with open(output_filename, 'w', encoding='utf-8') as f:
        json.dump(aircraft_data, f, indent=4)

    print(f"Success! Converted {len(aircraft_data)} entries to '{output_filename}'.")

# Run the function
if __name__ == "__main__":
    convert_html_to_json('aircraft.txt', 'aircraft.json')